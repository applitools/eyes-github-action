/**
 * Makes a failed baseline merge impossible to miss, and keeps it visible until the merge happens:
 *
 * - The merged PR gets one comment (found again by a hidden marker, edited rather than repeated) saying what went
 *   wrong and what to do, and the label `eyes-baselines-not-merged`. The label is also the stored state: the Action
 *   has nowhere else to keep the list of PRs whose baselines still need merging.
 * - Every build of the target branch retries those merges before its tests. While one still fails, the pushed commit
 *   gets a failing "Applitools / Baseline merge" check (a red X on the branch). Once it works, the label goes, the
 *   comment turns ✅ and the check passes.
 */
import {BASELINE_MERGE, CheckResult} from './checks.js'
import {MergeAttempt, MergeConfig, MergeDeps, MergeNote, MergedPullRequest, attemptMerge, logAttempt, plain} from './merge.js'

export const UNMERGED_LABEL = 'eyes-baselines-not-merged'
export const ALERT_MARKER = '<!-- applitools-baseline-merge -->'

export interface AlertOptions {
  /** Comment on and label the PR. */
  comment: boolean
  /** Fail the target branch's Baseline merge check while a merge is outstanding (otherwise it's neutral). */
  failBranch: boolean
}

export interface IssueComment {
  id: number
  body: string
}

export interface AlertGitHub {
  comments(pr: number): Promise<IssueComment[]>
  createComment(pr: number, body: string): Promise<void>
  updateComment(id: number, body: string): Promise<void>
  addLabel(pr: number, label: string): Promise<void>
  removeLabel(pr: number, label: string): Promise<void>
  /** Merged PRs into `base` that carry `label`. */
  labeledMergedPullRequests(base: string, label: string): Promise<MergedPullRequest[]>
}

export function failureComment(pr: MergedPullRequest, attempt: MergeAttempt, options: AlertOptions): string {
  const branch = `\`${pr.baseRef}\``
  const until = options.failBranch
    ? `builds of ${branch} fail the **${BASELINE_MERGE}** check`
    : `builds of ${branch} report it in the **${BASELINE_MERGE}** check`
  return (
    `${ALERT_MARKER}\n### ⚠️ Eyes baselines from this PR weren't merged into ${branch}\n\n` +
    `**${attempt.title}**\n\n${attempt.detail}\n\n` +
    `Until then, ${until}, and their tests may flag the changes this PR accepted. The next run on ${branch} after ` +
    "it's fixed confirms the merge and updates this comment.\n"
  )
}

export function mergedComment(pr: MergedPullRequest, attempt: MergeAttempt, runUrl: string): string {
  const how =
    attempt.outcome === 'NOTHING_TO_MERGE'
      ? `Nothing was left to merge from \`${attempt.source}\` into \`${attempt.target}\`. Confirmed by [this run](${runUrl}).`
      : `${attempt.detail} Merged by [this run](${runUrl}).`
  return `${ALERT_MARKER}\n### ✅ Eyes baselines from this PR are merged into \`${pr.baseRef}\`\n\n${how}\n`
}

/** Labels the PR and writes its comment (editing the existing one only if the text changed). Returns problems. */
export async function raiseAlert(
  github: AlertGitHub,
  pr: MergedPullRequest,
  attempt: MergeAttempt,
  options: AlertOptions
): Promise<string[]> {
  const problems: string[] = []
  if (!pr.labels?.includes(UNMERGED_LABEL)) {
    await attempt_(problems, `label PR #${pr.number} \`${UNMERGED_LABEL}\``, () => github.addLabel(pr.number, UNMERGED_LABEL), true)
  }
  const body = failureComment(pr, attempt, options)
  await attempt_(problems, `comment on PR #${pr.number}`, async () => {
    const existing = (await github.comments(pr.number)).find(c => c.body.includes(ALERT_MARKER))
    if (!existing) await github.createComment(pr.number, body)
    else if (existing.body !== body) await github.updateComment(existing.id, body)
  })
  return problems
}

/** Removes the label and turns an existing ⚠️ comment into ✅. Does nothing for a PR that never had a problem. */
export async function clearAlert(
  github: AlertGitHub,
  pr: MergedPullRequest,
  attempt: MergeAttempt,
  runUrl: string
): Promise<string[]> {
  const problems: string[] = []
  if (pr.labels?.includes(UNMERGED_LABEL)) {
    await attempt_(problems, `remove \`${UNMERGED_LABEL}\` from PR #${pr.number}`, () => github.removeLabel(pr.number, UNMERGED_LABEL))
  }
  await attempt_(problems, `update the comment on PR #${pr.number}`, async () => {
    const existing = (await github.comments(pr.number)).find(c => c.body.includes(ALERT_MARKER))
    if (existing && existing.body.includes('### ⚠️')) await github.updateComment(existing.id, mergedComment(pr, attempt, runUrl))
  })
  return problems
}

export interface RetryDeps extends Pick<MergeDeps, 'github' | 'eyes' | 'log' | 'repo' | 'sleep' | 'pollMs'> {
  alerts: AlertGitHub
}

export interface RetryReport {
  /** For the log, job summary and Visual tests check. */
  notes: MergeNote[]
  /** For the pushed commit; undefined when no PR was waiting for a merge. */
  check?: CheckResult
  /** Comments or labels that couldn't be written. */
  problems: string[]
}

/**
 * For a build of `branch`: retries the baseline merge of every merged PR into it that's still labeled, and says how
 * each went. `config.mergeApiKey` must be a key given for merging: without one nothing is retried (retrying with the
 * run key would only replace the real reason with "Eyes refused").
 */
export async function retryUnmergedBaselines(
  config: MergeConfig,
  deps: RetryDeps,
  branch: string,
  options: AlertOptions,
  urls: {run: string; pullRequest(n: number): string}
): Promise<RetryReport> {
  const prs = await deps.alerts.labeledMergedPullRequests(branch, UNMERGED_LABEL)
  const report: RetryReport = {notes: [], problems: []}
  if (prs.length === 0) return report

  deps.log.info(`Retrying the baseline merge for ${prs.length} merged PR${prs.length === 1 ? '' : 's'} labeled ${UNMERGED_LABEL}`)
  const sections: string[] = []
  const failing: MergedPullRequest[] = []
  for (const pr of prs) {
    const link = `[PR #${pr.number}](${urls.pullRequest(pr.number)})`
    if (!config.mergeApiKey) {
      failing.push(pr)
      const why =
        "This workflow has no Eyes merge key to retry with; pass `mergeApiKey: ${{ secrets.APPLITOOLS_MERGE_KEY }}` " +
        'to it. The PR\'s comment says why the merge failed.'
      sections.push(`❌ ${link}: not retried. ${why}`)
      report.notes.push({pr: pr.number, ok: false, line: `Eyes baselines from PR #${pr.number} still aren't merged into ${branch}. ${plain(why)}`})
      continue
    }
    const attempt = await attemptMerge(pr, config, deps)
    logAttempt(deps.log, pr, attempt)
    if (attempt.ok) {
      report.problems.push(...(await clearAlert(deps.alerts, pr, attempt, urls.run)))
      sections.push(`✅ ${link}: ${attempt.title}. ${attempt.detail}`)
      report.notes.push({pr: pr.number, ok: true, line: `Eyes baselines from PR #${pr.number} are now merged into ${branch}: ${attempt.title}.`})
    } else {
      failing.push(pr)
      if (options.comment) report.problems.push(...(await raiseAlert(deps.alerts, pr, attempt, options)))
      sections.push(`❌ ${link}: **${attempt.title}**. ${attempt.detail}`)
      report.notes.push({
        pr: pr.number,
        ok: false,
        line: `Eyes baselines from PR #${pr.number} still aren't merged into ${branch}: ${attempt.title}. ${plain(attempt.detail)}`
      })
    }
  }

  const merged = prs.length - failing.length
  let title: string
  if (failing.length === 0) {
    title = merged === 1 ? `Baselines from PR #${prs[0].number} merged into ${branch}` : `Baselines from ${merged} PRs merged into ${branch}`
  } else if (failing.length === 1) {
    title = `Baselines from PR #${failing[0].number} not merged into ${branch}`
  } else {
    title = `Baselines from ${failing.length} PRs not merged into ${branch}`
  }
  const footer =
    failing.length === 0
      ? ''
      : `\n\nUntil they're merged, this branch's tests may flag the changes those PRs accepted. Each PR has a comment ` +
        `with the details. Every build of \`${branch}\` retries the merge, and this check passes once it works.`
  report.check = {
    name: BASELINE_MERGE,
    status: 'completed',
    conclusion: failing.length === 0 ? 'success' : options.failBranch ? 'failure' : 'neutral',
    title,
    summary: sections.join('\n\n') + footer,
    detailsUrl: urls.run
  }
  return report
}

/** Runs a GitHub write; on failure records what couldn't be done and how to fix it. */
async function attempt_(problems: string[], what: string, fn: () => Promise<void>, labelNeeded = false): Promise<void> {
  try {
    await fn()
  } catch (e) {
    const status = (e as {status?: number}).status
    const why = status ? `HTTP ${status}` : e instanceof Error ? e.message : String(e)
    problems.push(
      `Couldn't ${what} (${why}). Give the workflow \`permissions: pull-requests: write\`.` +
        (labelNeeded ? ' Without the label, builds of the target branch won\'t retry this merge.' : '')
    )
  }
}
