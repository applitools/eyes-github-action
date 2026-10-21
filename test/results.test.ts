import {describe, expect, it} from 'vitest'
import {
  BatchResults,
  applyExpectations,
  changedTestIds,
  emptyResults,
  environment,
  outcome,
  parseResults,
  summary,
  verdictLine
} from '../src/results.js'

function results(overrides: Partial<BatchResults> = {}): BatchResults {
  return {...emptyResults('sha'), url: 'https://eyes/app/test-results/b1', ...overrides}
}

describe('parseResults', () => {
  it('reads statistics, tests and the Eyes batch ID (SPEC §10.3)', () => {
    const r = parseResults('sha', {
      statistics: {id: 'eyes-1', name: 'o/r PR #1: t', passed: 1, failed: 0, unresolved: 1, new: 0, aborted: 0, total: 2},
      batchUrl: 'https://eyes.applitools.com/app/test-results/eyes-1',
      tests: [
        {
          testId: 's1',
          testName: 'Button',
          appName: 'Storybook',
          status: 'Unresolved',
          env: {app: 'Chrome 155.0', os: 'Linux', device: 'Desktop', viewport: {width: 1280, height: 800}},
          sessionUrl: 'https://eyes/s1'
        },
        {testId: 's2', testName: 'Card', status: 'passed'}
      ]
    })
    expect(r.eyesBatchId).toBe('eyes-1')
    expect(r.unresolved).toBe(1)
    expect(r.total).toBe(2)
    expect(r.tests[0]).toEqual({
      id: 's1',
      name: 'Button',
      appName: 'Storybook',
      environment: 'Chrome 155.0 on Linux 1280×800',
      status: 'unresolved',
      url: 'https://eyes/s1'
    })
  })

  it('falls back to the number of tests when total is missing', () => {
    expect(parseResults('x', {statistics: {}, tests: [{testName: 'a'}]}).total).toBe(1)
  })
})

describe('environment', () => {
  it('names the device instead of the OS for non-desktop devices', () => {
    expect(environment({app: 'Safari', os: 'iOS 18', device: 'iPhone 16', viewport: {width: 390, height: 844}})).toBe(
      'Safari on iPhone 16 390×844'
    )
    expect(environment(undefined)).toBe('')
  })
})

describe('outcome and summary (SPEC §5.1, first match wins)', () => {
  it.each([
    [{total: 3, failed: 1, unresolved: 1, expectationProblem: 'no tests from Web'}, 'FAILED', 'Missing results: no tests from Web'],
    [{total: 0}, 'NO_RESULTS', 'No Eyes tests reported to this batch'],
    [{total: 4, failed: 1, unresolved: 2}, 'FAILED', '1 of 4 failed'],
    [{total: 4, failed: 2, aborted: 2}, 'FAILED', '2 of 4 failed (2 aborted before any checkpoint reached Eyes)'],
    [{total: 4, unresolved: 3}, 'CHANGES', '3 of 4 with visual changes to review'],
    [{total: 4, passed: 2, newTests: 2}, 'PASSED', '4 passed (2 new baselines)'],
    [{total: 4, passed: 4}, 'PASSED', '4 passed']
  ] as const)('%o → %s', (o, expected, text) => {
    const r = results(o as Partial<BatchResults>)
    expect(outcome(r)).toBe(expected)
    expect(summary(r)).toBe(text)
  })

  it('prints the verdict line with the batch URL (SPEC §4 step 8)', () => {
    expect(verdictLine(results({total: 2, unresolved: 1}))).toBe(
      'Changes to review: 1 of 2 with visual changes to review → https://eyes/app/test-results/b1'
    )
    expect(verdictLine(emptyResults('x'))).toBe('No results: No Eyes tests reported to this batch')
  })
})

describe('expectations (SPEC §5.2)', () => {
  const tests = [
    {id: 'a', name: 'a', appName: 'Storybook', environment: '', status: 'passed'},
    {id: 'b', name: 'b', appName: 'Web App', environment: '', status: 'unresolved'}
  ]

  it('fails when fewer tests than expected arrived', () => {
    const r = applyExpectations({minTests: 5, apps: []}, results({total: 2, passed: 2, tests}))
    expect(outcome(r)).toBe('FAILED')
    expect(summary(r)).toBe('Missing results: expected at least 5 tests, Eyes received 2')
  })

  it('matches app names case-insensitively and names the missing ones', () => {
    const r = applyExpectations({apps: ['storybook', 'WEB APP', 'Mobile', 'Docs']}, results({total: 2, tests}))
    expect(r.expectationProblem).toBe('no tests from Mobile, Docs')
  })

  it('joins several problems, and singular "test"', () => {
    const r = applyExpectations({minTests: 1, apps: ['X']}, emptyResults('x'))
    expect(r.expectationProblem).toBe('expected at least 1 test, Eyes received 0; no tests from X')
  })

  it('leaves met expectations alone and does not mutate the input', () => {
    const input = results({total: 2, unresolved: 1, tests})
    const r = applyExpectations({minTests: 2, apps: ['Storybook']}, input)
    expect(r.expectationProblem).toBeUndefined()
    expect(outcome(r)).toBe('CHANGES')
    expect(input).not.toBe(r)
  })
})

describe('changedTestIds', () => {
  it('lists unresolved tests that have IDs', () => {
    const r = results({
      tests: [
        {id: 'z', name: '', environment: '', status: 'unresolved'},
        {id: 'a', name: '', environment: '', status: 'unresolved'},
        {id: 'p', name: '', environment: '', status: 'passed'},
        {name: '', environment: '', status: 'unresolved'}
      ]
    })
    expect(changedTestIds(r)).toEqual(['a', 'z'])
  })
})
