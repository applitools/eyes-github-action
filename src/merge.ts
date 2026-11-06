/**
 * Baseline merge (SPEC §10.7, §11): when a PR merges, merge its Eyes baseline branch into the target branch's, so the
 * changes reviewers accepted don't show up again as diffs there. Every outcome, including skips, is posted as
 * "Applitools / Baseline merge" on the PR's last commit and fails the job when something needs fixing; the next build of
 * the target branch repeats it before its tests run.
 */
import {BASELINE_MERGE, CheckResult, VISUAL_TESTS} from './checks.js'
import {EyesClient, EyesHttpError} from './eyes.js'
import {Logger} from './gate.js'
import {Reporter} from './github.js'
import {PostedCheck} from './refresh.js'
import {decodeState} from './state.js'

export type MergeOutcome = 'MERGED' | 'NOTHING_TO_MERGE' | 'CONFLICTS' | 'REFUSED' | 'NO_KEY' | 'TIMED_OUT' | 'FAILED'

export interface MergeConfig {
  serverUrl: string
  /** Merge key, falling back to the run key; undefined when neither was given. */
  mergeApiKey?: string
  /** Seconds to wait for Eyes. */
  mergeTimeout: number
}

export interface MergedPullRequest {
  number: number
  title: string
  merged: boolean
  headSha: string
  headRef: string
  baseRef: string
  /** From a fork: its Eyes branch is `owner/repo/pr-N` (SPEC §3.2). */
  fork?: boolean
}

export interface MergeGitHub {
  /** Read from GitHub, never from the event payload (SPEC §8.3). */
  pullRequest(n: number): Promise<MergedPullRequest>
  /** PRs whose merge produced this commit. */
  pullRequestsForCommit(sha: string): Promise<MergedPullRequest[]>
  checks(sha: string, names: string[]): Promise<PostedCheck[]>
}

export interface MergeDeps {
  github: MergeGitHub
  /** Posts on the PR's last commit. */
  reporter(sha: string): Reporter | undefined
  eyes(apiKey: string): EyesClient
  log: Logger
  /** `owner/repo`, the Eyes branch prefix. */
  repo: string
  sleep?(ms: number): Promise<void>
  pollMs?: number
}

export interface MergeReport {
  pr: number
  /** Set when there was nothing to do (the PR closed without merging). */
  skipped?: string
  outcome?: MergeOutcome
  ok: boolean
  title?: string
  summary?: string
}

const OK: MergeOutcome[] = ['MERGED', 'NOTHING_TO_MERGE']

export async function runMerge(config: MergeConfig, deps: MergeDeps, prNumber: number): Promise<MergeReport> {
  const {log} = deps
  const pr = await deps.github.pullRequest(prNumber)
  if (!pr.merged) {
    const skipped = `PR #${pr.number} closed without merging, so its baselines stay on their branch.`
    log.info(skipped)
    return {pr: pr.number, skipped, ok: true}
  }

  // The branch the tests ran on, as the gated run recorded it; derived from the PR when no run recorded one.
  const state = (await deps.github.checks(pr.headSha, [VISUAL_TESTS]))
    .sort((a, b) => b.id - a.id)
    .map(c => decodeState(c.summary))
    .find(s => s !== undefined)
  const source = state?.branchName ?? `${deps.repo}/${pr.fork ? `pr-${pr.number}` : pr.headRef}`
  const target = `${deps.repo}/${pr.baseRef}`
  const how = `Eyes baseline branch \`${source}\` → \`${target}\``
  const fixThenRetry =
    `\n\nOnce that's fixed, re-run this job to retry, or merge by hand in Eyes under **Compare & merge branches** ` +
    `(\`${source}\` → \`${target}\`).`

  const reporter = deps.reporter(pr.headSha)
  await reporter?.publish({
    name: BASELINE_MERGE,
    status: 'in_progress',
    title: `Merging baselines into ${pr.baseRef}`,
    summary: `${how}.`
  })
  const report = async (outcome: MergeOutcome, title: string, summary: string): Promise<MergeReport> => {
    const ok = OK.includes(outcome)
    const full = ok ? summary : summary + fixThenRetry
    await reporter?.publish(mergeCheck(ok, title, full))
    if (ok) log.info(`Baseline merge from PR #${pr.number}: ${title}. ${plain(summary)}`)
    else log.warning(`Baseline merge from PR #${pr.number}: ${title}. ${plain(full)}`)
    return {pr: pr.number, outcome, ok, title, summary: full}
  }

  if (!config.mergeApiKey) {
    return report(
      'NO_KEY',
      'Baseline merge skipped',
      `No Eyes key to merge \`${source}\` into \`${target}\`. Pass an Eyes merge key as ` +
        '`mergeApiKey: ${{ secrets.APPLITOOLS_MERGE_KEY }}`.'
    )
  }

  const eyes = deps.eyes(config.mergeApiKey)
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>(r => setTimeout(r, ms)))
  try {
    const task = await eyes.startBranchMerge(source, target)
    log.info(`Merging ${source} into ${target} (Eyes task ${task})`)
    const deadline = Date.now() + config.mergeTimeout * 1000
    while (!(await eyes.isTaskDone(task))) {
      if (Date.now() > deadline) {
        return report(
          'TIMED_OUT',
          'Baseline merge timed out',
          `Eyes was still merging \`${source}\` into \`${target}\` after ${config.mergeTimeout}s. Check the branch in Eyes: ` +
            'the merge may still finish there.'
        )
      }
      await sleep(deps.pollMs ?? 5000)
    }
    const result = await eyes.taskResult(task)
    if (result.conflicts > 0) {
      return report(
        'CONFLICTS',
        `${result.conflicts} baseline conflict${result.conflicts === 1 ? '' : 's'}`,
        `The same checkpoints changed on \`${pr.baseRef}\` too. Resolve them in Eyes under **Compare & merge branches** ` +
          `(\`${source}\` → \`${target}\`).`
      )
    }
    if (result.merged) {
      return report(
        'MERGED',
        `Baselines merged into ${pr.baseRef}`,
        `${result.changes} baseline change${result.changes === 1 ? '' : 's'} from \`${source}\` now apply to \`${target}\`.`
      )
    }
    return report('NOTHING_TO_MERGE', 'Nothing to merge', `\`${source}\` had no baseline changes for \`${target}\`.`)
  } catch (e) {
    if (e instanceof EyesHttpError && e.unauthorized) {
      return report(
        'REFUSED',
        'Eyes refused the baseline merge',
        `HTTP ${e.status}: only Eyes **merge** keys (created for a team and a user) can merge baselines. Add one as the ` +
          'secret `APPLITOOLS_MERGE_KEY` and pass it as `mergeApiKey`.'
      )
    }
    let detail = e instanceof Error ? e.message : String(e)
    if (e instanceof EyesHttpError && e.status === 404 && !state) {
      detail +=
        ". No visual test run with Eyes results was found on this PR's last commit; if its tests never ran, there's " +
        'nothing to merge.'
    }
    return report('FAILED', 'Baseline merge failed', `${detail}.`.replace(/\.\.$/, '.'))
  }
}

function mergeCheck(ok: boolean, title: string, summary: string): CheckResult {
  return {name: BASELINE_MERGE, status: 'completed', conclusion: ok ? 'success' : 'failure', title, summary}
}

/** One line per baseline merge into the branch a build is about to test. */
export interface MergeNote {
  pr: number
  ok: boolean
  line: string
}

/**
 * For a branch build (not a PR): before its tests run, waits a little for baseline merges from the PRs that produced
 * this commit, so the tests don't compare against baselines without them, then says how each merge went. A failed or
 * skipped merge means the tests may flag the changes the PR accepted, so it's a warning.
 */
export async function mergeNotesBeforeTests(
  github: MergeGitHub,
  sha: string,
  branch: string,
  log: Logger,
  sleep: (ms: number) => Promise<void>,
  waitMs = 60_000,
  pollMs = 5000
): Promise<MergeNote[]> {
  const prs = (await github.pullRequestsForCommit(sha)).filter(p => p.merged && p.baseRef === branch)
  const notes: MergeNote[] = []
  const started = Date.now()
  for (const pr of prs) {
    const latest = async () =>
      (await github.checks(pr.headSha, [BASELINE_MERGE])).sort((a, b) => b.id - a.id)[0] as PostedCheck | undefined
    let check = await latest()
    if (check?.status !== 'completed' && check !== undefined) {
      log.info(`A baseline merge from PR #${pr.number} is running; waiting up to ${Math.round(waitMs / 1000)}s for it before the tests start`)
      while (check?.status !== 'completed' && Date.now() - started < waitMs) {
        await sleep(pollMs)
        check = await latest()
      }
    }
    let note: MergeNote
    if (!check) {
      note = {pr: pr.number, ok: true, line: `No baseline merge result from PR #${pr.number} (is the merge workflow set up?)`}
    } else if (check.status !== 'completed') {
      note = {
        pr: pr.number,
        ok: false,
        line:
          `The baseline merge from PR #${pr.number} was still running after ${Math.round((Date.now() - started) / 1000)}s. ` +
          "This build's tests may flag changes the PR accepted; if they do, re-run this job once the merge is done."
      }
    } else if (check.conclusion === 'success') {
      note = {pr: pr.number, ok: true, line: `Baseline merge from PR #${pr.number}: ${check.title}. ${plain(check.summary ?? '')}`}
    } else {
      note = {
        pr: pr.number,
        ok: false,
        line:
          `Baseline merge from PR #${pr.number}: ${check.title}. Until the baselines are merged, this build's tests may ` +
          `flag the changes the PR accepted.${check.url ? ` Details: ${check.url}` : ''}`
      }
    }
    if (note.ok) log.info(note.line)
    else log.warning(note.line)
    notes.push(note)
  }
  return notes
}

/** Markdown for the Visual tests check when a merge into this branch went wrong; empty otherwise. */
export function mergeNotesMarkdown(notes: MergeNote[]): string {
  const problems = notes.filter(n => !n.ok)
  return problems.length === 0 ? '' : `\n**Baseline merges**\n\n${problems.map(n => `- ⚠️ ${n.line}`).join('\n')}\n`
}

/** Check summaries are Markdown; logs aren't. */
function plain(markdown: string): string {
  return markdown.replace(/\*\*|`/g, '').replace(/\s*\n+\s*/g, ' ').trim()
}
