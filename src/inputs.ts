/** Action inputs (names follow SPEC §2, so docs transfer from the Jenkins plugin). */
import * as core from '@actions/core'
import {parseDesigners} from './designers.js'
import {ChangesPolicy, GateConfig, parseBool} from './gate.js'
import {Reporting} from './github.js'

export interface ActionInputs {
  run: string
  workingDirectory?: string
  githubToken?: string
  githubReporting: Reporting
  config: GateConfig
}

export function readInputs(env: NodeJS.ProcessEnv = process.env): ActionInputs {
  const apiKey = input('apiKey') ?? env.APPLITOOLS_API_KEY
  if (!apiKey) {
    throw new Error(
      'No Eyes API key. Pass `apiKey: ${{ secrets.APPLITOOLS_API_KEY }}` to the action ' +
        '(or set APPLITOOLS_API_KEY in the step environment).'
    )
  }
  const readApiKey = input('readApiKey') ?? env.APPLITOOLS_READ_KEY
  core.setSecret(apiKey)
  if (readApiKey) core.setSecret(readApiKey)

  const run = input('run')
  if (!run) throw new Error('`run` is required: the command that runs your Eyes tests.')

  return {
    run,
    workingDirectory: input('workingDirectory'),
    githubToken: input('githubToken'),
    githubReporting: oneOf('githubReporting', ['CHECKS', 'STATUSES'], 'CHECKS'),
    config: {
      apiKey,
      readApiKey,
      serverUrl: input('serverUrl') ?? env.APPLITOOLS_SERVER_URL ?? 'https://eyes.applitools.com',
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
      designReviewCheck: bool('designReviewCheck', true)
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
