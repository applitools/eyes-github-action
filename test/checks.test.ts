import {describe, expect, it} from 'vitest'
import {
  CheckResult,
  DESIGN_REVIEW,
  VISUAL_TESTS,
  designReviewResult,
  toStatus,
  visualTestsCompleted,
  visualTestsStarted,
  visualTestsUnavailable
} from '../src/checks.js'
import {BatchResults, emptyResults} from '../src/results.js'

const url = 'https://eyes.applitools.com/app/test-results/b1'

function results(overrides: Partial<BatchResults>): BatchResults {
  return {...emptyResults('sha'), url, name: 'o/r PR #3: Fix | header', ...overrides}
}

describe('Visual tests check (SPEC §7.1)', () => {
  it('starts in progress', () => {
    expect(visualTestsStarted('o/r PR #3: x')).toEqual({
      name: VISUAL_TESTS,
      status: 'in_progress',
      title: 'Running visual tests',
      summary: 'Batch: o/r PR #3: x'
    })
  })

  it.each([
    [{total: 2, passed: 2}, 'success', '2 passed'],
    [{total: 2, unresolved: 1}, 'action_required', '1 visual change to review'],
    [{total: 3, unresolved: 2}, 'action_required', '2 visual changes to review'],
    [{total: 2, failed: 1}, 'failure', '1 of 2 failed'],
    [{total: 0}, 'failure', 'No Eyes results'],
    [{total: 2, passed: 2, expectationProblem: 'no tests from X'}, 'failure', 'Missing results: no tests from X']
  ] as const)('%o → completed / %s, "%s"', (o, conclusion, title) => {
    const check = visualTestsCompleted(results(o as Partial<BatchResults>))
    expect(check).toMatchObject({name: VISUAL_TESTS, status: 'completed', conclusion, title, detailsUrl: url})
  })

  it('summarizes with a link, the outcome line and an escaped table', () => {
    const check = visualTestsCompleted(
      results({
        total: 3,
        unresolved: 1,
        passed: 1,
        newTests: 1,
        tests: [
          {id: 's1', name: 'Button | primary\nhover', environment: 'Chrome 155.0 on Linux 1280×800', status: 'unresolved', url: 'https://eyes/s1'},
          {id: 's2', name: 'Card', environment: 'Firefox', status: 'passed'},
          {id: 's3', name: 'Nav', environment: 'Safari', status: 'new'}
        ]
      })
    )
    expect(check.summary).toBe(
      `**[Review in Eyes](${url})** · o/r PR #3: Fix \\| header\n\n` +
        '1 of 3 with visual changes to review\n\n' +
        '| Test | Browser / device | Status |\n| --- | --- | --- |\n' +
        '| [Button \\| primary hover](https://eyes/s1) | Chrome 155.0 on Linux 1280×800 | ⚠️ unresolved |\n' +
        '| Card | Firefox | ✅ passed |\n' +
        '| Nav | Safari | ✅ new |\n'
    )
  })

  it('is neutral when results were not collected and failure when unreadable', () => {
    expect(visualTestsUnavailable('x', false)).toMatchObject({conclusion: 'neutral', title: 'Results not collected'})
    const blocking = visualTestsUnavailable('HTTP 403', true, 'https://github.com/o/r/actions/runs/1')
    expect(blocking).toMatchObject({conclusion: 'failure', title: "Couldn't read Eyes results"})
    expect(blocking.summary).toBe('HTTP 403\n\nSee the [workflow log](https://github.com/o/r/actions/runs/1) for details.')
  })
})

describe('Design review check (SPEC §7.1)', () => {
  it.each([
    ['NOT_REQUESTED', 'skipped'],
    ['WAITING', 'action_required'],
    ['APPROVED', 'success'],
    ['CHANGES_REQUESTED', 'failure']
  ] as const)('%s → completed / %s (never in_progress)', (state, conclusion) => {
    const check = designReviewResult({state, title: 'T', detail: 'D'}, url)
    expect(check).toEqual({
      name: DESIGN_REVIEW,
      status: 'completed',
      conclusion,
      title: 'T',
      summary: `**[Review in Eyes](${url})**\n\nD`,
      detailsUrl: url
    })
  })
})

describe('toStatus (SPEC §7.1 commit status column)', () => {
  const check = (status: CheckResult['status'], conclusion?: CheckResult['conclusion']): CheckResult => ({
    name: VISUAL_TESTS,
    status,
    conclusion,
    title: 't',
    summary: ''
  })

  it.each([
    [check('in_progress'), 'pending'],
    [check('completed', 'success'), 'success'],
    [check('completed', 'neutral'), 'success'],
    [check('completed', 'skipped'), 'success'],
    [check('completed', 'action_required'), 'pending'],
    [check('completed', 'failure'), 'failure']
  ])('%o → %s', (c, state) => {
    expect(toStatus(c).state).toBe(state)
  })

  it('caps descriptions at 140 characters', () => {
    const long = {...check('completed', 'failure'), title: 'x'.repeat(200), detailsUrl: url}
    const status = toStatus(long)
    expect(status.description).toHaveLength(140)
    expect(status.description.endsWith('…')).toBe(true)
    expect(status).toMatchObject({context: VISUAL_TESTS, targetUrl: url})
    expect(toStatus({...long, title: 'y'.repeat(140)}).description).toBe('y'.repeat(140))
  })
})
