import {describe, expect, it} from 'vitest'
import {designState, evaluate, isForced, isRequired} from '../src/design-review.js'
import {Designers, plainDesigners} from '../src/designers.js'
import {BatchResults, TestResult, emptyResults} from '../src/results.js'

const anyone = plainDesigners([])
const dana = plainDesigners(['Dana@Example.com'])

function test(id: string, status: string): TestResult {
  return {id, name: id, environment: '', status}
}

function results(overrides: Partial<BatchResults>): BatchResults {
  return {...emptyResults('sha'), ...overrides}
}

const accepted = results({total: 2, passed: 2, tests: [test('s1', 'passed'), test('s2', 'passed')]})

describe('isRequired (SPEC §6.1, first match wins)', () => {
  it.each([
    [{option: false, env: true, labelPresent: true, byDefault: true}, false],
    [{option: true, env: false, labelPresent: false, byDefault: false}, true],
    [{env: false, labelPresent: true, byDefault: true}, false],
    [{env: true, labelPresent: false, byDefault: false}, true],
    [{labelPresent: true, byDefault: false}, true],
    [{labelPresent: false, byDefault: true}, true],
    [{byDefault: false}, false]
  ])('%o → %s', (inputs, expected) => {
    expect(isRequired(inputs)).toBe(expected)
  })

  it('is forced only by the option or env', () => {
    expect(isForced({option: false, byDefault: false})).toBe(true)
    expect(isForced({env: true, byDefault: false})).toBe(true)
    expect(isForced({labelPresent: true, byDefault: true})).toBe(false)
  })
})

describe('evaluate (SPEC §6.2, first match wins)', () => {
  const none = new Map<string, Set<string>>()

  it('1: not requested names the label', () => {
    const v = evaluate(false, 'design-review', accepted, ['s1'], none, anyone)
    expect(v.state).toBe('NOT_REQUESTED')
    expect(v.title).toBe('Not requested')
    expect(v.detail).toContain('`design-review` label')
  })

  it('2: a changed test that is now failed means changes requested', () => {
    const r = results({total: 2, failed: 1, passed: 1, tests: [test('s1', 'failed'), test('s2', 'passed')]})
    expect(evaluate(true, 'l', r, ['s1'], none, anyone)).toMatchObject({
      state: 'CHANGES_REQUESTED',
      title: 'Changes requested'
    })
  })

  it('2b: other failures mean the visual tests failed', () => {
    const r = results({total: 2, failed: 1, passed: 1, tests: [test('s1', 'passed'), test('s2', 'failed')]})
    const v = evaluate(true, 'l', r, ['s1'], none, anyone)
    expect(v).toMatchObject({state: 'CHANGES_REQUESTED', title: 'Visual tests failed'})
    expect(v.detail).toBe('1 of 2 failed. Fix the tests before design review.')
  })

  it('3: unresolved changes wait for review', () => {
    const r = results({total: 2, unresolved: 1, tests: [test('s1', 'unresolved')]})
    expect(evaluate(true, 'l', r, ['s1'], none, anyone)).toMatchObject({
      state: 'WAITING',
      title: 'Waiting for design review',
      detail: '1 visual change to review in Eyes.'
    })
    expect(evaluate(true, 'l', results({total: 3, unresolved: 2}), [], none, dana).detail).toBe(
      '2 visual changes to review in Eyes by a designer.'
    )
  })

  it('4: no changes in this build', () => {
    expect(evaluate(true, 'l', accepted, [], none, dana).title).toBe('No visual changes')
  })

  it('5: anyone may approve', () => {
    expect(evaluate(true, 'l', accepted, ['s1', 's2'], none, anyone)).toMatchObject({
      state: 'APPROVED',
      title: 'Approved',
      detail: '2 changes accepted in Eyes.'
    })
  })

  it('6: designers configured but none resolved fails closed', () => {
    const unresolved: Designers = {entries: ['team:Design'], allowed: new Set(), problem: "Eyes team 'Design' not found"}
    expect(evaluate(true, 'l', accepted, ['s1'], none, unresolved)).toMatchObject({
      state: 'WAITING',
      title: "Designers couldn't be determined",
      detail: "Nobody can approve until this is fixed: Eyes team 'Design' not found."
    })
  })

  it('7: every changed test accepted by a designer (emails match case-insensitively)', () => {
    const approvers = new Map([
      ['s1', new Set(['dana@example.com'])],
      ['s2', new Set(['DANA@example.com', 'dev@example.com'])]
    ])
    const v = evaluate(true, 'l', accepted, ['s1', 's2'], approvers, dana)
    expect(v.state).toBe('APPROVED')
    expect(v.title).toMatch(/^Approved by dana@example\.com/i)
  })

  it('8: accepted by someone else waits for a designer and names them', () => {
    const approvers = new Map([
      ['s1', new Set(['dana@example.com'])],
      ['s2', new Set(['dev@example.com'])]
    ])
    const designers: Designers = {...dana, problem: "Eyes team 'X' has no members"}
    expect(evaluate(true, 'l', accepted, ['s1', 's2'], approvers, designers)).toMatchObject({
      state: 'WAITING',
      title: 'Waiting for a designer',
      detail:
        "Changes were accepted by dev@example.com, but a designer (Dana@Example.com) must approve them. Note: Eyes team 'X' has no members."
    })
  })

  it('8: no approvals recorded yet', () => {
    expect(evaluate(true, 'l', accepted, ['s1'], none, dana).detail).toBe(
      'Changes were accepted, but a designer (Dana@Example.com) must approve them.'
    )
  })

  it('designState compares by state and title', () => {
    expect(designState({state: 'WAITING', title: 'Waiting for design review', detail: 'x'})).toBe(
      'WAITING: Waiting for design review'
    )
  })
})
