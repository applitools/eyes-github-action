import {afterEach, beforeEach, describe, expect, it} from 'vitest'
import {CheckResult, DESIGN_REVIEW, VISUAL_TESTS} from '../src/checks.js'
import {EyesClient} from '../src/eyes.js'
import {PostedCheck, PullRequest, RefreshConfig, RefreshDeps, latestRun, runRefresh} from '../src/refresh.js'
import {GateState, decodeState, encodeState} from '../src/state.js'
import {FakeEyes} from './fake-eyes.js'

const ACTIONS = 15368
const JENKINS = 5398251

let eyes: FakeEyes
let prs: PullRequest[]
let checks: Map<string, PostedCheck[]>
let updates: {id: number; result: CheckResult}[]
let creates: {sha: string; result: CheckResult; externalId: string}[]
let logs: string[]
let nextId: number

function check(sha: string, c: Partial<PostedCheck> & {name: string}): PostedCheck {
  const posted: PostedCheck = {id: nextId++, appId: ACTIONS, status: 'completed', conclusion: 'success', title: '', summary: '', ...c}
  checks.set(sha, [...(checks.get(sha) ?? []), posted])
  return posted
}

/** A finished gated run with one change to review, as runGate leaves it. */
function gatedRun(sha: string, state: Partial<GateState> = {}, design = {conclusion: 'skipped', title: 'Not requested'}) {
  const visual = check(sha, {
    name: VISUAL_TESTS,
    conclusion: 'action_required',
    title: '1 visual change to review',
    summary: `table${encodeState({v: 1, batchId: sha, eyesBatchId: 'eyes-1', changed: ['s1'], ...state})}`
  })
  return {visual, design: check(sha, {name: DESIGN_REVIEW, ...design})}
}

function config(overrides: Partial<RefreshConfig> = {}): RefreshConfig {
  return {
    apiKey: 'READ',
    readApiKey: 'READ',
    designReviewLabel: 'design-review',
    designers: [],
    designReviewByDefault: false,
    designReviewCheck: true,
    ...overrides
  }
}

function deps(): RefreshDeps {
  return {
    github: {
      pullRequests: async only => prs.filter(p => only === undefined || p.number === only),
      checks: async sha => checks.get(sha) ?? [],
      update: async (id, result) => void updates.push({id, result}),
      create: async (sha, result, externalId) => void creates.push({sha, result, externalId})
    },
    eyes: key => new EyesClient(eyes.url, key),
    log: {info: m => logs.push(m), warning: m => logs.push(`WARN ${m}`)},
    env: {}
  }
}

function accept(sha: string, by = 'dana@example.com') {
  eyes.batches.set(sha, {
    eyesBatchId: 'eyes-1',
    name: 'n',
    tests: [
      {testId: 's1', testName: 'Header', status: 'passed', acceptedBy: by},
      {testId: 's2', testName: 'Footer', status: 'passed'}
    ]
  })
}

beforeEach(async () => {
  eyes = await new FakeEyes().start()
  eyes.keys.set('READ', {read: true, orgId: 'org1'})
  eyes.teams = [{id: 't1', name: 'Design', members: {'dana@example.com': {}}}]
  prs = [{number: 7, headSha: 'sha7', labels: []}]
  checks = new Map()
  updates = []
  creates = []
  logs = []
  nextId = 100
})

afterEach(() => eyes.stop())

describe('runRefresh', () => {
  it('updates both checks in place once the changes are accepted in Eyes', async () => {
    prs[0].labels = ['Design-Review']
    const run = gatedRun('sha7', {}, {conclusion: 'action_required', title: 'Waiting for design review'})
    accept('sha7')

    const [outcome] = await runRefresh(config({designers: ['team:Design']}), deps())

    expect(updates.map(u => [u.id, u.result.conclusion, u.result.title])).toEqual([
      [run.visual.id, 'success', '2 passed'],
      [run.design.id, 'success', 'Approved by dana@example.com']
    ])
    // The state survives, with the tests that changed in the gated run, not now.
    expect(decodeState(updates[0].result.summary)).toMatchObject({batchId: 'sha7', changed: ['s1']})
    expect(outcome.visual).toEqual({from: '1 visual change to review', to: '2 passed', posted: true})
    expect(logs).toContain('PR #7: Visual tests "1 visual change to review" → "2 passed"; Design review "Waiting for design review" → "Approved by dana@example.com"')
    // Results are read with the read key only.
    expect(eyes.requests.every(r => r.apiKey === 'READ')).toBe(true)
  })

  it('posts nothing when nothing changed', async () => {
    gatedRun('sha7')
    eyes.batches.set('sha7', {eyesBatchId: 'eyes-1', name: 'n', tests: [{testId: 's1', testName: 'Header', status: 'unresolved'}]})
    const [outcome] = await runRefresh(config(), deps())
    expect(updates).toEqual([])
    expect(outcome.design).toEqual({from: 'Not requested', to: 'Not requested', posted: false})
  })

  it('requests design review when the label is added after the run', async () => {
    const run = gatedRun('sha7')
    eyes.batches.set('sha7', {eyesBatchId: 'eyes-1', name: 'n', tests: [{testId: 's1', testName: 'Header', status: 'unresolved'}]})
    prs[0].labels = ['design-review']
    await runRefresh(config(), deps(), 7)
    expect(updates).toEqual([{id: run.design.id, result: expect.objectContaining({conclusion: 'action_required', title: 'Waiting for design review'})}])
  })

  it('ignores the label when the gated run forced design review off', async () => {
    gatedRun('sha7', {designForced: false})
    accept('sha7')
    prs[0].labels = ['design-review']
    await runRefresh(config(), deps())
    expect(updates.find(u => u.result.name === DESIGN_REVIEW)).toBeUndefined()
  })

  it('re-applies the gated run\'s expectations', async () => {
    gatedRun('sha7', {expectApps: ['Storybook']})
    accept('sha7')
    await runRefresh(config(), deps())
    expect(updates[0].result).toMatchObject({conclusion: 'failure', title: "Missing results: no tests from Storybook"})
  })

  it('creates Design review when the gated run had none', async () => {
    const visual = check('sha7', {
      name: VISUAL_TESTS,
      conclusion: 'action_required',
      title: '1 visual change to review',
      summary: encodeState({v: 1, batchId: 'sha7', changed: ['s1']})
    })
    accept('sha7')
    await runRefresh(config(), deps())
    expect(updates.map(u => u.id)).toEqual([visual.id])
    expect(creates).toEqual([{sha: 'sha7', externalId: 'sha7', result: expect.objectContaining({conclusion: 'skipped', title: 'Not requested'})}])
    creates = []
    await runRefresh(config({designReviewCheck: false}), deps())
    expect(creates).toEqual([])
  })

  it('carries on with other PRs when one fails', async () => {
    prs.push({number: 8, headSha: 'sha8', labels: []})
    gatedRun('sha7')
    gatedRun('sha8')
    accept('sha8')
    eyes.keys.set('RUN', {read: false})
    const outcomes = await runRefresh(config({readApiKey: undefined, apiKey: 'RUN'}), deps())
    expect(outcomes.map(o => o.skipped)).toEqual([
      "couldn't refresh: Eyes refused to share results (HTTP 403); pass a read key as readApiKey",
      "couldn't refresh: Eyes refused to share results (HTTP 403); pass a read key as readApiKey"
    ])
    expect(logs.filter(l => l.startsWith('WARN')).length).toBe(2)
  })
})

describe('latestRun', () => {
  it('skips a commit with no gated run', () => {
    expect(latestRun([])).toEqual({skipped: 'no finished gated run with Eyes results on its head commit'})
  })

  it('leaves a run in progress alone', () => {
    gatedRun('sha7')
    check('sha7', {name: VISUAL_TESTS, status: 'in_progress', conclusion: null, title: 'Running visual tests'})
    expect(latestRun(checks.get('sha7')!)).toEqual({skipped: 'a gated run is in progress; it posts its own results'})
  })

  it('follows the newest run, even one without results', () => {
    gatedRun('sha7')
    check('sha7', {name: VISUAL_TESTS, conclusion: 'failure', title: 'No Eyes results'})
    expect(latestRun(checks.get('sha7')!)).toEqual({skipped: 'the latest gated run has no Eyes results to follow'})
  })

  it("ignores another app's checks with the same names", () => {
    const run = gatedRun('sha7')
    check('sha7', {name: VISUAL_TESTS, appId: JENKINS, status: 'in_progress', title: 'Running visual tests'})
    check('sha7', {name: DESIGN_REVIEW, appId: JENKINS, conclusion: 'skipped', title: 'Not requested'})
    const found = latestRun(checks.get('sha7')!)
    expect(found).toMatchObject({visual: {id: run.visual.id}, design: {id: run.design.id}})
  })
})
