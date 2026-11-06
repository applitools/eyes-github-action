/** Action inputs (names follow SPEC §2, so docs transfer from the Jenkins plugin). */
import * as core from '@actions/core'
import {parseDesigners} from './designers.js'
import {ChangesPolicy, GateConfig, parseBool} from './gate.js'
import {Reporting} from './github.js'
import {MergeConfig} from './merge.js'
import {AlertOptions} from './merge-alerts.js'

export type Mode = 'RUN' | 'REFRESH' | 'MERGE' | 'DOCTOR'

export interface ActionInputs {
  mode: Mode
  /** The test command; only in RUN mode. */
  run?: string
  workingDirectory?: string
  githubToken?: string
  githubReporting: Reporting
  config: GateConfig
  merge: MergeConfig
  /** What a failed baseline merge does besides failing the merge job. */
  alerts: AlertOptions
  /** Keys as given, for the setup check. */
  keys: {apiKey?: string; readApiKey?: string; mergeApiKey?: string}
  /** Plain http to a server other than this machine. */
  allowHttp: boolean
  /** Give fork PRs' test code the run key. */
  allowForkPullRequests: boolean
}

export function readInputs(env: NodeJS.ProcessEnv = process.env): ActionInputs {
  const mode = oneOf<Mode>('mode', ['RUN', 'REFRESH', 'MERGE', 'DOCTOR'], 'RUN')
  const readApiKey = input('readApiKey') ?? env.APPLITOOLS_READ_KEY
  const mergeApiKey = input('mergeApiKey') ?? env.APPLITOOLS_MERGE_KEY
  const runApiKey = input('apiKey') ?? env.APPLITOOLS_API_KEY
  // A refresh only reads, so the read key is enough. A merge or a setup check without a key reports it instead.
  const apiKey = runApiKey ?? (mode === 'REFRESH' ? readApiKey : mode === 'RUN' ? undefined : '')
  if (apiKey === undefined) {
    throw new Error(
      mode === 'REFRESH'
        ? 'No Eyes read key. Pass `readApiKey: ${{ secrets.APPLITOOLS_READ_KEY }}` to the action.'
        : 'No Eyes API key. Pass `apiKey: ${{ secrets.APPLITOOLS_API_KEY }}` to the action ' +
            '(or set APPLITOOLS_API_KEY in the step environment).'
    )
  }
  for (const key of [apiKey, readApiKey, mergeApiKey]) if (key) core.setSecret(key)

  const run = input('run')
  if (mode === 'RUN' && !run) throw new Error('`run` is required: the command that runs your Eyes tests.')
  const githubReporting = oneOf<Reporting>('githubReporting', ['CHECKS', 'STATUSES'], 'CHECKS')
  if ((mode === 'REFRESH' || mode === 'MERGE') && githubReporting === 'STATUSES') {
    throw new Error(
      `\`mode: ${mode.toLowerCase()}\` needs check runs (the run state lives in them); remove \`githubReporting: STATUSES\`.`
    )
  }
  const serverUrl = input('serverUrl') ?? env.APPLITOOLS_SERVER_URL ?? 'https://eyes.applitools.com'

  return {
    mode,
    run,
    workingDirectory: input('workingDirectory'),
    githubToken: input('githubToken'),
    githubReporting,
    config: {
      apiKey,
      readApiKey,
      serverUrl,
      batch: {
        batchId: expandVars(input('batchId'), env),
        batchName: expandVars(input('batchName'), env),
        branchName: expandVars(input('branchName'), env),
        parentBranchName: expandVars(input('parentBranchName'), env)
      },
      scm: {
        repo: input('repo'),
        pullRequest: input('pullRequest'),
        commit: input('commit'),
        branch: input('branch'),
        targetBranch: input('targetBranch')
      },
      closeBatch: bool('closeBatch', true),
      waitForResults: bool('waitForResults', true),
      resultsTimeout: positiveInt('resultsTimeout') ?? 300,
      onChanges: oneOf<ChangesPolicy>('onChanges', ['SUCCESS', 'UNSTABLE', 'FAILURE'], 'SUCCESS'),
      judgeDiffs: bool('judgeDiffs', true),
      expectations: {minTests: positiveInt('expectTests'), apps: parseDesigners(input('expectApps'))},
      checks: bool('checks', true),
      designReview: parseBool(input('designReview')),
      designReviewLabel: input('designReviewLabel') ?? 'design-review',
      designers: parseDesigners(input('designers')),
      designReviewByDefault: bool('designReviewByDefault', false),
      designReviewCheck: bool('designReviewCheck', true),
      hideReviewers: bool('hideReviewers', false),
      apiKeyInQuery: bool('apiKeyInQuery', false)
    },
    keys: {apiKey: runApiKey, readApiKey, mergeApiKey},
    allowHttp: bool('allowHttp', false),
    allowForkPullRequests: bool('allowForkPullRequests', false),
    // Merge key, then the run key (SPEC §11).
    merge: {serverUrl, mergeApiKey: mergeApiKey || apiKey || undefined, mergeTimeout: positiveInt('mergeTimeout') ?? 600},
    alerts: {
      comment: bool('baselineMergeAlerts', true),
      failBranch: bool('failBranchOnUnmergedBaselines', true)
    }
  }
}

/** `${VAR}` references, like the Jenkins step options (SPEC §2). Unknown variables are left as they are. */
export function expandVars(value: string | undefined, env: NodeJS.ProcessEnv): string | undefined {
  return value?.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g, (all, name: string) => env[name] ?? all)
}

function input(name: string): string | undefined {
  const value = core.getInput(name).trim()
  return value === '' ? undefined : value
}

function bool(name: string, fallback: boolean): boolean {
  const value = input(name)
  if (value === undefined) return fallback
  const parsed = parseBool(value)
  if (parsed === undefined) throw new Error(`\`${name}\` must be true or false, not '${value}'`)
  return parsed
}

function positiveInt(name: string): number | undefined {
  const value = input(name)
  if (value === undefined) return undefined
  const n = Number(value)
  if (!Number.isInteger(n) || n < 0) throw new Error(`\`${name}\` must be a whole number, not '${value}'`)
  return n
}

function oneOf<T extends string>(name: string, allowed: T[], fallback: T): T {
  const value = input(name)?.toUpperCase()
  if (value === undefined) return fallback
  if (!(allowed as string[]).includes(value)) {
    throw new Error(`\`${name}\` must be one of ${allowed.join(', ')}, not '${value}'`)
  }
  return value as T
}
