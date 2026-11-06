/**
 * Refresh (SPEC §8.2): re-read a finished run's batch from Eyes and update both checks in place, without running tests.
 * Started by a schedule, by hand, or by a label change. The state comes from the Visual tests check the gated run
 * posted (state.ts), so this needs no storage of its own.
 */
import {ENV_DESIGN_REVIEW} from './context.js'
import {DesignInputs, Verdict} from './design-review.js'
import {CheckResult, DESIGN_REVIEW, VISUAL_TESTS, designReviewResult, visualTestsCompleted} from './checks.js'
import {EyesClient, EyesHttpError} from './eyes.js'
import {GateConfig, Logger, evaluateDesign, parseBool} from './gate.js'
import {applyExpectations} from './results.js'
import {GateState, decodeState, encodeState} from './state.js'

export type RefreshConfig = Pick<
  GateConfig,
  | 'apiKey'
  | 'readApiKey'
  | 'designReview'
  | 'designReviewLabel'
  | 'designers'
  | 'designReviewByDefault'
  | 'designReviewCheck'
  | 'hideReviewers'
>

export interface PullRequest {
  number: number
  headSha: string
  labels: string[]
}

/** A check run as GitHub lists it. */
export interface PostedCheck {
  id: number
  name: string
  appId?: number
  status: string
  conclusion: string | null
  title: string | null
  summary: string | null
  /** The check's page on GitHub. */
  url?: string
}

/** The GitHub side of a refresh. */
export interface RefreshGitHub {
  /** The one PR asked for, or every open PR. */
  pullRequests(only?: number): Promise<PullRequest[]>
  /** Check runs with these names on a commit, any app, any order. */
  checks(sha: string, names: string[]): Promise<PostedCheck[]>
  update(id: number, result: CheckResult): Promise<void>
  create(sha: string, result: CheckResult, externalId: string): Promise<void>
}

export interface RefreshDeps {
  github: RefreshGitHub
  eyes(apiKey: string): EyesClient
  log: Logger
  env: NodeJS.ProcessEnv
}

export interface CheckChange {
  from?: string
  to: string
  posted: boolean
}

export interface PullRequestRefresh {
  pr: number
  /** Why it was left alone. */
  skipped?: string
  visual?: CheckChange
  design?: CheckChange
}

export async function runRefresh(config: RefreshConfig, deps: RefreshDeps, only?: number): Promise<PullRequestRefresh[]> {
  const prs = await deps.github.pullRequests(only)
  deps.log.info(only === undefined ? `Refreshing ${prs.length} open pull request(s)` : `Refreshing PR #${only}`)
  const done: PullRequestRefresh[] = []
  for (const pr of prs) {
    let outcome: PullRequestRefresh
    try {
      outcome = await refreshPullRequest(config, deps, pr)
    } catch (e) {
      outcome = {pr: pr.number, skipped: `couldn't refresh: ${message(e)}`}
      deps.log.warning(`PR #${pr.number}: ${outcome.skipped}`)
    }
    done.push(outcome)
    deps.log.info(describeRefresh(outcome))
  }
  return done
}

export async function refreshPullRequest(
  config: RefreshConfig,
  deps: RefreshDeps,
  pr: PullRequest
): Promise<PullRequestRefresh> {
  const found = latestRun(await deps.github.checks(pr.headSha, [VISUAL_TESTS, DESIGN_REVIEW]))
  if ('skipped' in found) return {pr: pr.number, skipped: found.skipped}
  const {visual, design, state} = found

  const reader = deps.eyes(config.readApiKey ?? config.apiKey)
  let fetched
  try {
    fetched = await reader.getResults(state.batchId)
  } catch (e) {
    if (e instanceof EyesHttpError && e.unauthorized) {
      throw new Error(`Eyes refused to share results (HTTP ${e.status}); pass a read key as readApiKey`)
    }
    throw e
  }
  if (!fetched) return {pr: pr.number, skipped: `Eyes has no results for batch ${state.batchId}`}

  // Expectations and changed tests come from the gated run, not this workflow's inputs.
  const results = applyExpectations({minTests: state.expectTests, apps: state.expectApps ?? []}, fetched)
  const newVisual = visualTestsCompleted(results)
  newVisual.summary += encodeState({...state, eyesBatchId: results.eyesBatchId ?? state.eyesBatchId})
  const outcome: PullRequestRefresh = {pr: pr.number, visual: await post(deps.github, visual, newVisual)}

  if (design || config.designReviewCheck) {
    const inputs: DesignInputs = {
      // A forced review (designReview option or env in the gated run) ignores labels (SPEC §6.1).
      option: state.designForced ?? config.designReview,
      env: parseBool(deps.env[ENV_DESIGN_REVIEW]),
      labelPresent: pr.labels.some(l => l.toLowerCase() === config.designReviewLabel.toLowerCase()),
      byDefault: config.designReviewByDefault
    }
    let verdict: Verdict
    try {
      verdict = await evaluateDesign(config, inputs, results, state.changed, reader)
    } catch (e) {
      deps.log.warning(`PR #${pr.number}: could not evaluate design review: ${message(e)}`)
      verdict = {state: 'WAITING', title: "Design review couldn't be evaluated", detail: `${message(e)}. The next refresh tries again.`}
    }
    const newDesign = designReviewResult(verdict, results.url)
    if (design) {
      outcome.design = await post(deps.github, design, newDesign)
    } else {
      await deps.github.create(pr.headSha, newDesign, state.batchId)
      outcome.design = {to: newDesign.title, posted: true}
    }
  }
  return outcome
}

type LatestRun = {visual: PostedCheck; design?: PostedCheck; state: GateState} | {skipped: string}

/**
 * The newest gated run's checks. Other apps (the Jenkins plugin, say) may post checks with the same names, so ours are
 * the ones from the app that posted the newest Visual tests check carrying gate state.
 */
export function latestRun(checks: PostedCheck[]): LatestRun {
  const newest = [...checks].sort((a, b) => b.id - a.id)
  const withState = newest.find(c => c.name !== DESIGN_REVIEW && decodeState(c.summary))
  if (!withState) return {skipped: 'no finished gated run with Eyes results on its head commit'}
  const ours = newest.filter(c => c.appId === withState.appId)
  const visual = ours.find(c => c.name === withState.name)!
  if (visual.id !== withState.id) {
    return {
      skipped:
        visual.status === 'completed'
          ? 'the latest gated run has no Eyes results to follow'
          : 'a gated run is in progress; it posts its own results'
    }
  }
  return {visual, design: ours.find(c => c.name === DESIGN_REVIEW), state: decodeState(withState.summary)!}
}

/** Posts only on change, comparing state and title (SPEC §8.2). */
async function post(github: RefreshGitHub, current: PostedCheck, next: CheckResult): Promise<CheckChange> {
  const from = current.title ?? undefined
  if (current.status === 'completed' && current.conclusion === next.conclusion && current.title === next.title) {
    return {from, to: next.title, posted: false}
  }
  await github.update(current.id, next)
  return {from, to: next.title, posted: true}
}

export function describeRefresh(r: PullRequestRefresh): string {
  if (r.skipped) return `PR #${r.pr}: skipped, ${r.skipped}`
  const part = (name: string, c?: CheckChange) =>
    !c ? undefined : c.posted ? `${name} ${c.from ? `"${c.from}" → ` : ''}"${c.to}"` : `${name} unchanged ("${c.to}")`
  return `PR #${r.pr}: ${[part('Visual tests', r.visual), part('Design review', r.design)].filter(Boolean).join('; ')}`
}

function message(e: unknown): string {
  return e instanceof Error ? e.message : String(e)
}
