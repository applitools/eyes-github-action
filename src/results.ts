/**
 * One Eyes batch's results, as returned by `GET /api/v1/batches/{pointerId}` (SPEC §10.3), and the gate's outcome
 * (SPEC §5).
 */

import {safeLink} from './security.js'

export type Outcome = 'FAILED' | 'CHANGES' | 'PASSED' | 'NO_RESULTS'

export const OUTCOME_LABELS: Record<Outcome, string> = {
  FAILED: 'Failed',
  CHANGES: 'Changes to review',
  PASSED: 'Passed',
  NO_RESULTS: 'No results'
}

/** One test (one browser/device combination of one test case). */
export interface TestResult {
  /** Eyes test (session) ID. */
  id?: string
  name: string
  appName?: string
  environment: string
  /** Lowercase Eyes status: passed, unresolved, failed, new, … */
  status: string
  url?: string
}

export interface BatchResults {
  /** The pointer ID the SDKs were given. */
  batchId: string
  /** Eyes' own batch ID; needed for session-level calls. */
  eyesBatchId?: string
  name?: string
  url?: string
  passed: number
  failed: number
  unresolved: number
  newTests: number
  aborted: number
  total: number
  tests: TestResult[]
  /** Set when the batch didn't contain what the run expected (SPEC §5.2). */
  expectationProblem?: string
}

/** A batch Eyes never heard of: no tests reported to it. */
export function emptyResults(batchId: string): BatchResults {
  return {batchId, passed: 0, failed: 0, unresolved: 0, newTests: 0, aborted: 0, total: 0, tests: []}
}

export function parseResults(batchId: string, json: any): BatchResults {
  const stats = json?.statistics ?? {}
  const tests: TestResult[] = Array.isArray(json?.tests)
    ? json.tests.map((t: any) => ({
        id: str(t?.testId),
        name: str(t?.testName) ?? '',
        appName: str(t?.appName),
        environment: environment(t?.env),
        status: (str(t?.status) ?? '').toLowerCase(),
        url: safeLink(str(t?.sessionUrl))
      }))
    : []
  return {
    batchId,
    eyesBatchId: str(stats.id),
    name: str(stats.name),
    url: safeLink(str(json?.batchUrl)),
    passed: int(stats.passed),
    failed: int(stats.failed),
    unresolved: int(stats.unresolved),
    newTests: int(stats.new),
    aborted: int(stats.aborted),
    total: stats.total === undefined || stats.total === null ? tests.length : int(stats.total),
    tests
  }
}

/** "Chrome 155.0 on Linux 1280×800", or the device name instead of the OS for non-desktop devices. */
export function environment(env: any): string {
  if (!env || typeof env !== 'object') return ''
  const app = str(env.app) ?? ''
  const device = str(env.device) ?? ''
  const os = str(env.os) ?? ''
  const size = env.viewport ? ` ${int(env.viewport.width)}×${int(env.viewport.height)}` : ''
  const where = device === '' || device === 'Desktop' ? os : device
  return `${app}${where === '' ? '' : ` on ${where}`}${size}`.trim()
}

function str(value: any): string | undefined {
  return value === undefined || value === null ? undefined : String(value)
}

function int(value: any): number {
  const n = Number(value)
  return Number.isFinite(n) ? Math.trunc(n) : 0
}

/** SPEC §5.1, first match wins. */
export function outcome(results: BatchResults): Outcome {
  if (results.expectationProblem) return 'FAILED'
  if (results.total === 0) return 'NO_RESULTS'
  if (results.failed > 0 || results.aborted > 0) return 'FAILED'
  if (results.unresolved > 0) return 'CHANGES'
  return 'PASSED'
}

/** One-line summary for logs and check titles. */
export function summary(results: BatchResults): string {
  if (results.expectationProblem) return `Missing results: ${results.expectationProblem}`
  const {failed, total, aborted, unresolved, newTests} = results
  switch (outcome(results)) {
    case 'NO_RESULTS':
      return 'No Eyes tests reported to this batch'
    case 'FAILED':
      return `${failed} of ${total} failed${aborted > 0 ? ` (${aborted} aborted before any checkpoint reached Eyes)` : ''}`
    case 'CHANGES':
      return `${unresolved} of ${total} with visual changes to review`
    case 'PASSED':
      return `${total} passed${newTests > 0 ? ` (${newTests} new baselines)` : ''}`
  }
}

/** `<Outcome>: <summary> → <batch URL>`, printed before the step fails (SPEC §4 step 8). */
export function verdictLine(results: BatchResults): string {
  return `${OUTCOME_LABELS[outcome(results)]}: ${summary(results)}${results.url ? ` → ${results.url}` : ''}`
}

/** Compares refreshes: post only when this changes (SPEC §8.2). */
export function visualState(results: BatchResults): string {
  return `${outcome(results)}: ${summary(results)}`
}

/** Tests with visual changes when the run finished: the ones design review is about (SPEC §6.2). */
export function changedTestIds(results: BatchResults): string[] {
  return results.tests
    .filter(t => t.status === 'unresolved' && t.id)
    .map(t => t.id as string)
    .sort()
}

/** What a run's batch must contain (SPEC §5.2), so a suite that silently ran nothing can't pass the gate. */
export interface Expectations {
  minTests?: number
  apps: string[]
}

export function checkExpectations(expect: Expectations, results: BatchResults): string | undefined {
  const problems: string[] = []
  const min = expect.minTests
  if (min !== undefined && min > 0 && results.total < min) {
    problems.push(`expected at least ${min} test${min === 1 ? '' : 's'}, Eyes received ${results.total}`)
  }
  if (expect.apps.length > 0) {
    const seen = new Set(results.tests.filter(t => t.appName).map(t => (t.appName as string).toLowerCase()))
    const missing = expect.apps.filter(a => !seen.has(a.toLowerCase()))
    if (missing.length > 0) problems.push(`no tests from ${missing.join(', ')}`)
  }
  return problems.length > 0 ? problems.join('; ') : undefined
}

/** Returns a copy of the results marked failed if the expectations aren't met. */
export function applyExpectations(expect: Expectations, results: BatchResults): BatchResults {
  const problem = checkExpectations(expect, results)
  return {...results, expectationProblem: problem}
}
