import {afterEach, beforeEach, describe, expect, it} from 'vitest'
import {CheckResult} from '../src/checks.js'
import {scmFromEvent} from '../src/context.js'
import {EyesClient} from '../src/eyes.js'
import {GateConfig, GateDeps, evaluateDesign, runGate} from '../src/gate.js'
import {decodeState} from '../src/state.js'
import {FakeEyes} from './fake-eyes.js'

let eyes: FakeEyes
let posted: {result: CheckResult; externalId?: string}[]
let logs: string[]
let commandEnv: Record<string, string> | undefined

const scm = scmFromEvent({
  eventName: 'pull_request',
  sha: 'merge-sha',
  ref: 'refs/pull/7/merge',
  repo: {owner: 'acme', repo: 'web'},
  payload: {
    pull_request: {
      number: 7,
      title: 'New header',
      head: {sha: 'head-sha', ref: 'feature'},
      base: {ref: 'main'},
      labels: [{name: 'design-review'}]
    }
  }
})

function config(overrides: Partial<GateConfig> = {}): GateConfig {
  return {
    apiKey: 'RUN',
    readApiKey: 'READ',
    serverUrl: eyes.url,
    batch: {},
    scm: {},
    closeBatch: true,
    waitForResults: true,
    resultsTimeout: 5,
    onChanges: 'SUCCESS',
    judgeDiffs: true,
    expectations: {apps: []},
    checks: true,
    designReviewLabel: 'design-review',
    designers: [],
    designReviewByDefault: false,
    designReviewCheck: true,
    ...overrides
  }
}

function deps(overrides: Partial<GateDeps> = {}, exitCode = 0): GateDeps {
  return {
    runCommand: async env => {
      commandEnv = env
      return exitCode
    },
    eyes: key => new EyesClient(eyes.url, key),
    reporter: {publish: async (result, externalId) => void posted.push({result, externalId})},
    log: {info: m => logs.push(m), warning: m => logs.push(`WARN ${m}`)},
    env: {},
    scm,
    fallbackLabel: 'wf #1',
    logUrl: 'https://github.com/acme/web/actions/runs/1',
    sleep: async () => {},
    pollMs: 0,
    ...overrides
  }
}

function last(name: string): CheckResult | undefined {
  return posted.filter(p => p.result.name === name).at(-1)?.result
}

beforeEach(async () => {
  eyes = await new FakeEyes().start()
  eyes.keys.set('RUN', {read: false})
  eyes.keys.set('READ', {read: true, orgId: 'org1'})
  posted = []
  logs = []
  commandEnv = undefined
})

afterEach(() => eyes.stop())

describe('runGate', () => {
  it('runs a PR with changes: in progress → action required, design review waiting', async () => {
    eyes.batches.set('head-sha', {
      eyesBatchId: 'eyes-1',
      name: 'acme/web PR #7: New header',
      running: [1, 0],
      tests: [
        {testId: 's1', testName: 'Header', status: 'unresolved'},
        {testId: 's2', testName: 'Footer', status: 'passed'}
      ]
    })
    const result = await runGate(config({expectations: {minTests: 2, apps: []}}), deps())

    expect(commandEnv).toMatchObject({APPLITOOLS_BATCH_ID: 'head-sha', APPLITOOLS_BRANCH_NAME: 'acme/web/feature'})
    expect(posted.map(p => [p.result.name, p.result.status, p.result.conclusion, p.result.title])).toEqual([
      ['Applitools / Visual tests', 'in_progress', undefined, 'Running visual tests'],
      ['Applitools / Design review', 'in_progress', undefined, 'Waiting for visual tests'],
      ['Applitools / Visual tests', 'completed', 'action_required', '1 visual change to review'],
      ['Applitools / Design review', 'completed', 'action_required', 'Waiting for design review']
    ])
    expect(posted.every(p => p.externalId === 'head-sha')).toBe(true)
    expect(decodeState(last('Applitools / Visual tests')!.summary)).toEqual({
      v: 1,
      batchId: 'head-sha',
      branchName: 'acme/web/feature',
      eyesBatchId: 'eyes-1',
      changed: ['s1'],
      expectTests: 2
    })
    expect(eyes.batches.get('head-sha')!.closed).toBe(true)
    // Results were read with the read key, closing with the run key.
    expect(eyes.requests.find(r => r.path.startsWith('/api/v1/batches'))!.apiKey).toBe('READ')
    expect(eyes.requests.find(r => r.method === 'DELETE')!.apiKey).toBe('RUN')
    expect(logs).toContain(`Changes to review: 1 of 2 with visual changes to review → ${eyes.url}/app/test-results/eyes-1`)
    expect(result.failure).toBeUndefined()
    expect(result.warning).toBeUndefined()
    expect((await runGate(config({onChanges: 'UNSTABLE'}), deps())).warning).toContain('Visual changes to review')
  })

  it('fails the step on changes with onChanges: FAILURE, and stays quiet with SUCCESS', async () => {
    eyes.batches.set('head-sha', {eyesBatchId: 'e', name: 'n', tests: [{testId: 's1', testName: 'a', status: 'unresolved'}]})
    expect((await runGate(config({onChanges: 'FAILURE'}), deps())).failure).toBe('Failed: visual changes to review')
    const quiet = await runGate(config({onChanges: 'SUCCESS'}), deps())
    expect(quiet.failure ?? quiet.warning).toBeUndefined()
  })

  it('reports a failed baseline merge into a branch build, before its tests and with its results', async () => {
    eyes.batches.set('main-sha', {eyesBatchId: 'e', name: 'n', tests: [{testId: 's1', testName: 'a', status: 'unresolved'}]})
    const push = scmFromEvent({eventName: 'push', sha: 'main-sha', ref: 'refs/heads/main', repo: {owner: 'acme', repo: 'web'}, payload: {}})
    const order: string[] = []
    const result = await runGate(
      config(),
      deps({
        scm: push,
        mergeNotes: async () => (order.push('notes'), [{pr: 7, ok: false, line: 'Baseline merge from PR #7: 1 baseline conflict.'}]),
        runCommand: async () => (order.push('tests'), 0)
      })
    )
    expect(order).toEqual(['notes', 'tests'])
    expect(last('Applitools / Visual tests')!.summary).toContain('- ⚠️ Baseline merge from PR #7: 1 baseline conflict.')
    expect(result.mergeNotes).toHaveLength(1)

    // PR builds don't look for merges.
    posted = []
    let asked = false
    await runGate(config(), deps({mergeNotes: async () => ((asked = true), [])}))
    expect(asked).toBe(false)
  })

  it('posts Design review as skipped when not requested', async () => {
    eyes.batches.set('head-sha', {eyesBatchId: 'e', name: 'n', tests: [{testId: 's1', testName: 'a', status: 'passed'}]})
    const noLabel = {...scm, labels: []}
    await runGate(config(), deps({scm: noLabel}))
    expect(last('Applitools / Visual tests')).toMatchObject({conclusion: 'success', title: '1 passed'})
    expect(last('Applitools / Design review')).toMatchObject({conclusion: 'skipped', title: 'Not requested'})
  })

  it('reads labels when the tests finish, so a label added mid-run counts', async () => {
    eyes.batches.set('head-sha', {eyesBatchId: 'e', name: 'n', tests: [{testId: 's1', testName: 'a', status: 'unresolved'}]})
    await runGate(config(), deps({scm: {...scm, labels: []}, currentLabels: async () => ['Design-Review']}))
    expect(last('Applitools / Design review')!.title).toBe('Waiting for design review')
  })

  it("falls back to the event's labels when the PR can't be read", async () => {
    eyes.batches.set('head-sha', {eyesBatchId: 'e', name: 'n', tests: [{testId: 's1', testName: 'a', status: 'unresolved'}]})
    await runGate(config(), deps({currentLabels: async () => Promise.reject(new Error('HTTP 403'))}))
    expect(last('Applitools / Design review')!.title).toBe('Waiting for design review')
    expect(logs.some(l => l.includes("Could not read pull request labels"))).toBe(true)
  })

  it('honours APPLITOOLS_DESIGN_REVIEW over the label and records it as forced', async () => {
    eyes.batches.set('head-sha', {eyesBatchId: 'e', name: 'n', tests: [{testId: 's1', testName: 'a', status: 'unresolved'}]})
    await runGate(config(), deps({env: {APPLITOOLS_DESIGN_REVIEW: 'false'}}))
    expect(last('Applitools / Design review')!.conclusion).toBe('skipped')
    expect(decodeState(last('Applitools / Visual tests')!.summary)!.designForced).toBe(false)
  })

  it('treats a batch Eyes never saw as no results, failing unmet expectations', async () => {
    const result = await runGate(config({expectations: {minTests: 1, apps: []}}), deps())
    expect(last('Applitools / Visual tests')).toMatchObject({conclusion: 'failure', title: 'Missing results: expected at least 1 test, Eyes received 0'})
    // Labelled PR: design review can't be decided without results, but must not stay in progress.
    expect(last('Applitools / Design review')).toMatchObject({status: 'completed', conclusion: 'action_required', title: 'Waiting for visual tests'})
    expect(result.failure).toBe('Failed: expected at least 1 test, Eyes received 0')

    posted = []
    const plain = await runGate(config(), deps())
    expect(last('Applitools / Visual tests')).toMatchObject({conclusion: 'failure', title: 'No Eyes results'})
    expect(plain.failure).toBeUndefined()
  })

  it('explains a run key without execute permission (it can only show up as no results otherwise)', async () => {
    eyes.keys.set('WRITE', {read: false, permissions: ['write']})
    await runGate(config({apiKey: 'WRITE'}), deps())
    const check = last('Applitools / Visual tests')!
    expect(check.title).toBe('No Eyes results')
    expect(check.summary).toContain('has write permission, so Eyes refuses its test uploads')
    expect(logs.some(l => l.startsWith('WARN The Eyes API key (apiKey) has write permission'))).toBe(true)
  })

  it('stays quiet about a proper run key', async () => {
    await runGate(config(), deps())
    expect(logs.some(l => l.includes('permission'))).toBe(false)
  })

  it('posts "Couldn\'t read Eyes results" when only a run key is available, without failing the step', async () => {
    eyes.batches.set('head-sha', {eyesBatchId: 'e', name: 'n', tests: [{testId: 's1', testName: 'a', status: 'passed'}]})
    const result = await runGate(config({readApiKey: undefined}), deps())
    expect(last('Applitools / Visual tests')).toMatchObject({conclusion: 'failure', title: "Couldn't read Eyes results"})
    expect(last('Applitools / Visual tests')!.summary).toContain('add a read key as `readApiKey`')
    expect(result.failure).toBeUndefined()
    expect(logs.some(l => l.startsWith('WARN Eyes refused to share results'))).toBe(true)
  })

  it('is neutral with waitForResults: false, and completes a not-requested design review as skipped', async () => {
    eyes.batches.set('head-sha', {eyesBatchId: 'e', name: 'n', tests: []})
    await runGate(config({waitForResults: false}), deps({scm: {...scm, labels: []}}))
    expect(last('Applitools / Visual tests')).toMatchObject({conclusion: 'neutral', title: 'Results not collected'})
    expect(last('Applitools / Design review')).toMatchObject({status: 'completed', conclusion: 'skipped', title: 'Not requested'})
  })

  it('never leaves Design review in progress when results are unreadable', async () => {
    eyes.batches.set('head-sha', {eyesBatchId: 'e', name: 'n', tests: [{testId: 's1', testName: 'a', status: 'passed'}]})
    await runGate(config({readApiKey: undefined}), deps())
    expect(last('Applitools / Design review')).toMatchObject({status: 'completed', conclusion: 'action_required'})
  })

  it('posts no Design review at all with designReviewCheck: false', async () => {
    eyes.batches.set('head-sha', {eyesBatchId: 'e', name: 'n', tests: [{testId: 's1', testName: 'a', status: 'passed'}]})
    await runGate(config({designReviewCheck: false}), deps({scm: {...scm, labels: []}}))
    expect(posted.some(p => p.result.name === 'Applitools / Design review')).toBe(false)
  })

  it('prints the verdict before failing on a failed test command', async () => {
    eyes.batches.set('head-sha', {eyesBatchId: 'e', name: 'n', tests: [{testId: 's1', testName: 'a', status: 'failed'}]})
    const result = await runGate(config(), deps({}, 3))
    expect(result.failure).toBe('The test command exited with code 3')
    expect(logs.some(l => l.startsWith('Failed: 1 of 1 failed'))).toBe(true)
    expect(last('Applitools / Design review')).toMatchObject({conclusion: 'failure', title: 'Visual tests failed'})
  })

  it('posts nothing with checks: false', async () => {
    eyes.batches.set('head-sha', {eyesBatchId: 'e', name: 'n', tests: [{testId: 's1', testName: 'a', status: 'passed'}]})
    await runGate(config({checks: false}), deps())
    expect(posted).toEqual([])
  })

  it('keeps going when Eyes is unreachable', async () => {
    const result = await runGate(config({serverUrl: 'http://127.0.0.1:1'}), deps({eyes: key => new EyesClient('http://127.0.0.1:1', key)}))
    expect(last('Applitools / Visual tests')).toMatchObject({conclusion: 'failure', title: "Couldn't read Eyes results"})
    expect(result.failure).toBeUndefined()
  })
})

describe('evaluateDesign on a refresh (after reviewers acted in Eyes)', () => {
  beforeEach(() => {
    eyes.teams = [{id: 't1', name: "Tim's Eyes Org", members: {'dana@example.com': {}}}]
    eyes.batches.set('head-sha', {
      eyesBatchId: 'eyes-1',
      name: 'n',
      tests: [
        {testId: 's1', testName: 'a', status: 'passed', acceptedBy: 'Dana@Example.com'},
        {testId: 's2', testName: 'b', status: 'passed', acceptedBy: 'dev@example.com'}
      ]
    })
  })

  async function verdict(designers: string[], changed: string[]) {
    const reader = new EyesClient(eyes.url, 'READ')
    const results = (await reader.getResults('head-sha'))!
    return evaluateDesign({designers, designReviewLabel: 'design-review'}, {byDefault: true}, results, changed, reader)
  }

  it('approves when an Eyes team designer accepted every changed test', async () => {
    expect(await verdict(["team:Tim's Eyes Org"], ['s1'])).toMatchObject({state: 'APPROVED', title: 'Approved by Dana@Example.com'})
  })

  it('waits when a non-designer accepted one of them', async () => {
    expect(await verdict(["team:Tim's Eyes Org"], ['s1', 's2'])).toMatchObject({
      state: 'WAITING',
      title: 'Waiting for a designer',
      detail: "Changes were accepted by dev@example.com, but a designer (team:Tim's Eyes Org) must approve them."
    })
  })

  it('fails closed when the team is unknown', async () => {
    expect(await verdict(['team:Nobody'], ['s1'])).toMatchObject({title: "Designers couldn't be determined"})
  })

  it('needs no session lookups when anyone may approve', async () => {
    expect(await verdict([], ['s1', 's2'])).toMatchObject({state: 'APPROVED', title: 'Approved'})
    expect(eyes.requests.some(r => r.path.startsWith('/api/sessions/batches/eyes-1/'))).toBe(false)
  })
})
