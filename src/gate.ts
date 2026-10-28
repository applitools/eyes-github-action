/**
 * One gated run (SPEC §4): set up Eyes through the environment, run the tests, close the batch, wait for rendering,
 * read the results, and post "Visual tests" and "Design review". Problems talking to Eyes or GitHub never fail the run
 * by themselves; they're logged, and the PR results reflect them.
 */
import {
  BatchOverrides,
  ENV_DESIGN_REVIEW,
  ENV_MANAGED,
  ScmInfo,
  ScmOverrides,
  computeBatch,
  gateEnv,
  isPullRequest,
  withOverrides
} from './context.js'
import {
  BatchResults,
  Expectations,
  applyExpectations,
  changedTestIds,
  emptyResults,
  outcome,
  verdictLine
} from './results.js'
import {DesignInputs, Verdict, evaluate, isForced, isRequired} from './design-review.js'
import {Designers, isTeam, plainDesigners, resolveDesigners} from './designers.js'
import {
  CheckResult,
  designReviewResult,
  designReviewStarted,
  visualTestsCompleted,
  visualTestsStarted,
  visualTestsUnavailable
} from './checks.js'
import {EyesClient, EyesHttpError} from './eyes.js'
import {Reporter} from './github.js'
import {encodeState} from './state.js'

export type ChangesPolicy = 'UNSTABLE' | 'FAILURE' | 'SUCCESS'

export interface GateConfig {
  apiKey: string
  /** Read key; the run key is used when absent (it usually can't read results: SPEC §10.1). */
  readApiKey?: string
  serverUrl: string
  batch: BatchOverrides
  scm: ScmOverrides
  closeBatch: boolean
  waitForResults: boolean
  /** Seconds. */
  resultsTimeout: number
  onChanges: ChangesPolicy
  judgeDiffs: boolean
  expectations: Expectations
  checks: boolean
  designReview?: boolean
  designReviewLabel: string
  designers: string[]
  designReviewByDefault: boolean
  designReviewCheck: boolean
}

export interface Logger {
  info(message: string): void
  warning(message: string): void
}

export interface GateDeps {
  /** Runs the user's test command with the extra environment; resolves to its exit code. */
  runCommand(env: Record<string, string>): Promise<number>
  eyes(apiKey: string): EyesClient
  /** Undefined when results shouldn't (or can't) be posted. */
  reporter?: Reporter
  log: Logger
  /** The step's environment, for "unless already set" and `APPLITOOLS_DESIGN_REVIEW`. */
  env: NodeJS.ProcessEnv
  /** Event-derived PR/branch context, before overrides. */
  scm: ScmInfo
  /** Names the batch when there's no SCM info. */
  fallbackLabel: string
  /** Current PR labels, read when the tests finish (a label added mid-run counts); undefined falls back to the event. */
  currentLabels?(): Promise<string[] | undefined>
  /** Link to this workflow run, for check summaries. */
  logUrl?: string
  sleep?(ms: number): Promise<void>
  pollMs?: number
}

export interface GateResult {
  batchId: string
  commandExitCode: number
  results?: BatchResults
  /** Set when results couldn't be collected. */
  problem?: string
  design?: Verdict
  /** Why the step should fail, if it should. */
  failure?: string
  /** Set when unreviewed changes should be flagged without failing (`onChanges: UNSTABLE`). */
  warning?: string
  /** What was posted, for the job summary. */
  posted: CheckResult[]
}

export async function runGate(config: GateConfig, deps: GateDeps): Promise<GateResult> {
  const {log} = deps
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>(r => setTimeout(r, ms)))
  const pollMs = deps.pollMs ?? 5000
  const posted: CheckResult[] = []

  if (deps.env[ENV_MANAGED] === 'true') {
    log.info(`Nested gate: reusing batch ${deps.env.APPLITOOLS_BATCH_ID}`)
    const code = await deps.runCommand({})
    return {batchId: deps.env.APPLITOOLS_BATCH_ID ?? '', commandExitCode: code, posted, failure: commandFailure(code)}
  }

  const scm = withOverrides(deps.scm, config.scm)
  const batch = computeBatch(scm, deps.fallbackLabel, config.batch)
  const env = gateEnv(batch, config.apiKey, config.serverUrl, config.judgeDiffs, deps.env)
  log.info(`Batch "${batch.batchName}" (id ${batch.batchId})`)
  if (batch.branchName) {
    log.info(
      `Branch ${batch.branchName}${batch.parentBranchName ? ` ← baseline from ${batch.parentBranchName}` : ''}`
    )
  }
  log.info(`Server ${config.serverUrl}`)

  const reporter = config.checks ? deps.reporter : undefined
  const publish = async (result: CheckResult, externalId?: string): Promise<void> => {
    posted.push(result)
    await reporter?.publish(result, externalId)
  }
  await publish(visualTestsStarted(batch.batchName), batch.batchId)
  // A new check run per run, so in progress is allowed here; it clears the previous run's verdict right away.
  const designCheck = config.designReviewCheck || config.designReview === true
  if (designCheck) await publish(designReviewStarted(), batch.batchId)
  const designInputs = async (): Promise<DesignInputs> => ({
    option: config.designReview,
    env: parseBool(deps.env[ENV_DESIGN_REVIEW]),
    labelPresent: labelPresent({...scm, labels: (await currentLabels(deps, log)) ?? scm.labels}, config.designReviewLabel),
    byDefault: config.designReviewByDefault
  })
  /**
   * Without results, Design review can't be decided. It must still be completed: GitHub never completes a check run
   * the API created, so one left in progress would block the PR forever.
   */
  const designWithoutResults = async (): Promise<void> => {
    if (!designCheck) return
    const verdict: Verdict = isRequired(await designInputs())
      ? {state: 'WAITING', title: 'Waiting for visual tests', detail: "Design review is decided once this build's visual tests have results."}
      : evaluate(false, config.designReviewLabel, emptyResults(batch.batchId), [], new Map(), plainDesigners([]))
    await publish(designReviewResult(verdict), batch.batchId)
  }

  const commandExitCode = await deps.runCommand(env)
  const base = {batchId: batch.batchId, commandExitCode, posted}

  const eyes = deps.eyes(config.apiKey)
  if (!config.closeBatch) {
    log.info(`closeBatch: false, leaving batch ${batch.batchId} open`)
  } else if (!(await close(eyes, batch.batchId, log))) {
    // Nothing ran, so there are no results to collect; the gate must not pass on an empty run.
    const none = applyExpectations(config.expectations, emptyResults(batch.batchId))
    await publish(visualTestsCompleted(none), batch.batchId)
    await designWithoutResults()
    log.info(verdictLine(none))
    return {
      ...base,
      results: none,
      failure: commandFailure(commandExitCode) ?? (none.expectationProblem ? `Failed: ${none.expectationProblem}` : undefined)
    }
  }

  if (!config.waitForResults) {
    await publish(visualTestsUnavailable("`waitForResults: false`, so this run didn't wait for Eyes.", false, deps.logUrl))
    await designWithoutResults()
    return {...base, failure: commandFailure(commandExitCode)}
  }

  const reader = config.readApiKey ? deps.eyes(config.readApiKey) : eyes
  const collected = await collect(reader, batch.batchId, config.resultsTimeout, log, sleep, pollMs)
  if (!collected.results) {
    await publish(visualTestsUnavailable(collected.problem, true, deps.logUrl))
    await designWithoutResults()
    return {...base, problem: collected.problem, failure: commandFailure(commandExitCode)}
  }

  const results = applyExpectations(config.expectations, collected.results)
  const changed = changedTestIds(results)
  const inputs = await designInputs()
  const visual = visualTestsCompleted(results)
  visual.summary += encodeState({
    v: 1,
    batchId: batch.batchId,
    eyesBatchId: results.eyesBatchId,
    changed,
    expectTests: config.expectations.minTests,
    expectApps: config.expectations.apps.length > 0 ? config.expectations.apps : undefined,
    designForced: isForced(inputs) ? isRequired(inputs) : undefined
  })
  await publish(visual, batch.batchId)

  let design: Verdict | undefined
  if (designCheck) {
    try {
      design = await evaluateDesign(config, inputs, results, changed, reader)
    } catch (e) {
      log.warning(`Could not evaluate design review: ${message(e)}`)
      design = {state: 'WAITING', title: "Design review couldn't be evaluated", detail: `${message(e)}. Re-run the job to try again.`}
    }
    await publish(designReviewResult(design, results.url), batch.batchId)
    log.info(`Design review: ${design.title}`)
  }

  // Always print the verdict first: when the test command already failed, CI often shows only the first error.
  log.info(verdictLine(results))
  const o = outcome(results)
  let failure = commandFailure(commandExitCode)
  let warning: string | undefined
  if (!failure && o === 'FAILED') failure = 'Failed: visual tests failed in Eyes'
  if (o === 'CHANGES') {
    if (config.onChanges === 'FAILURE') failure ??= 'Failed: visual changes to review'
    else if (config.onChanges === 'UNSTABLE') warning = `Visual changes to review in Eyes: ${results.url ?? batch.batchId}`
  }
  return {...base, results, design, failure, warning}
}

/**
 * Evaluates Design review against current results. At the end of a run every changed test is still unresolved; the
 * approver lookups matter on later refreshes, once reviewers have acted in Eyes.
 */
export async function evaluateDesign(
  config: Pick<GateConfig, 'designers' | 'designReviewLabel'>,
  inputs: DesignInputs,
  results: BatchResults,
  changed: string[],
  reader: EyesClient
): Promise<Verdict> {
  const required = isRequired(inputs)
  // Expand team: entries only when a review actually needs them.
  const designers: Designers =
    required && config.designers.some(isTeam)
      ? await resolveDesigners(config.designers, () => reader.ownTeams())
      : plainDesigners(config.designers)
  const approvers = new Map<string, Set<string>>()
  // Session-level lookups only matter once every change is resolved and identity matters.
  if (
    required &&
    config.designers.length > 0 &&
    results.unresolved === 0 &&
    results.failed === 0 &&
    results.eyesBatchId
  ) {
    for (const id of changed) approvers.set(id, await reader.sessionApprovers(results.eyesBatchId, id))
  }
  return evaluate(required, config.designReviewLabel, results, changed, approvers, designers)
}

/** @returns false if Eyes has never heard of the batch (no tests reported to it) */
async function close(eyes: EyesClient, batchId: string, log: Logger): Promise<boolean> {
  try {
    if (!(await eyes.closeBatch(batchId))) {
      log.info(`No Eyes results for batch ${batchId} (did any tests run?)`)
      return false
    }
    log.info(`Closed batch ${batchId}`)
  } catch (e) {
    log.warning(`Could not close batch ${batchId}: ${message(e)}`)
  }
  return true
}

type Collected = {results: BatchResults; problem?: undefined} | {results?: undefined; problem: string}

async function collect(
  eyes: EyesClient,
  batchId: string,
  timeoutSeconds: number,
  log: Logger,
  sleep: (ms: number) => Promise<void>,
  pollMs: number
): Promise<Collected> {
  try {
    const deadline = Date.now() + timeoutSeconds * 1000
    let running = await eyes.runningCount(batchId)
    if (running > 0) log.info(`Waiting for ${running} test(s) to finish in Eyes…`)
    while (running > 0 && Date.now() < deadline) {
      await sleep(pollMs)
      running = await eyes.runningCount(batchId)
    }
    if (running > 0) {
      log.warning(`${running} test(s) still running after ${timeoutSeconds}s; recording partial results`)
    }
    const results = await eyes.getResults(batchId)
    if (!results) {
      log.info(`No Eyes results for batch ${batchId}`)
      return {problem: `Eyes has no results for batch \`${batchId}\`.`}
    }
    return {results}
  } catch (e) {
    if (e instanceof EyesHttpError && e.unauthorized) {
      log.warning(
        `Eyes refused to share results for batch ${batchId} (HTTP ${e.status}). Run keys can't read results: ` +
          'pass a read key as readApiKey (e.g. secrets.APPLITOOLS_READ_KEY).'
      )
      return {
        problem:
          `Eyes refused to share results (HTTP ${e.status}). Run keys can't read results; ` +
          'add a read key as `readApiKey`.'
      }
    }
    log.warning(`Could not read results for batch ${batchId}: ${message(e)}`)
    return {problem: `Couldn't reach Eyes to read results: ${message(e)}`}
  }
}

async function currentLabels(deps: GateDeps, log: Logger): Promise<string[] | undefined> {
  try {
    return await deps.currentLabels?.()
  } catch (e) {
    log.warning(`Could not read pull request labels, using the event's: ${message(e)}`)
    return undefined
  }
}

function labelPresent(scm: ScmInfo, label: string): boolean | undefined {
  if (!isPullRequest(scm) || !scm.labels) return undefined
  return scm.labels.some(l => l.toLowerCase() === label.toLowerCase())
}

function commandFailure(code: number): string | undefined {
  return code === 0 ? undefined : `The test command exited with code ${code}`
}

export function parseBool(value: string | undefined): boolean | undefined {
  const v = value?.trim().toLowerCase()
  if (v === 'true') return true
  if (v === 'false') return false
  return undefined
}

function message(e: unknown): string {
  return e instanceof Error ? e.message : String(e)
}
