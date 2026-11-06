import {afterEach, beforeEach, describe, expect, it} from 'vitest'
import {BASELINE_MERGE, CheckResult, VISUAL_TESTS} from '../src/checks.js'
import {EyesClient} from '../src/eyes.js'
import {MergeConfig, MergeDeps, MergedPullRequest, mergeNotesBeforeTests, mergeNotesMarkdown, runMerge} from '../src/merge.js'
import {PostedCheck} from '../src/refresh.js'
import {encodeState} from '../src/state.js'
import {FakeEyes} from './fake-eyes.js'

let eyes: FakeEyes
let pr: MergedPullRequest
let checks: PostedCheck[]
let posted: {sha: string; result: CheckResult}[]
let logs: string[]

function config(overrides: Partial<MergeConfig> = {}): MergeConfig {
  return {serverUrl: eyes.url, mergeApiKey: 'MERGE', mergeTimeout: 600, ...overrides}
}

function deps(overrides: Partial<MergeDeps> = {}): MergeDeps {
  return {
    github: {
      pullRequest: async () => pr,
      pullRequestsForCommit: async () => [pr],
      checks: async (_sha, names) => checks.filter(c => names.includes(c.name))
    },
    reporter: sha => ({publish: async result => void posted.push({sha, result})}),
    eyes: key => new EyesClient(eyes.url, key),
    log: {info: m => logs.push(m), warning: m => logs.push(`WARN ${m}`)},
    repo: 'acme/web',
    sleep: async () => {},
    pollMs: 0,
    ...overrides
  }
}

function last(): CheckResult {
  return posted.at(-1)!.result
}

beforeEach(async () => {
  eyes = await new FakeEyes().start()
  eyes.keys.set('MERGE', {read: true, merge: true})
  eyes.keys.set('RUN', {read: false})
  eyes.branches.add('acme/web/feature').add('acme/web/main')
  pr = {number: 7, title: 'New header', merged: true, headSha: 'head-sha', headRef: 'feature', baseRef: 'main'}
  checks = []
  posted = []
  logs = []
})

afterEach(() => eyes.stop())

describe('runMerge', () => {
  it("merges the PR's branch into the target's and says how many changes now apply", async () => {
    eyes.mergeRunning = 2
    const report = await runMerge(config(), deps(), 7)

    expect(eyes.merges).toEqual(['acme/web/feature → acme/web/main'])
    expect(posted.map(p => [p.sha, p.result.status, p.result.conclusion, p.result.title])).toEqual([
      ['head-sha', 'in_progress', undefined, 'Merging baselines into main'],
      ['head-sha', 'completed', 'success', 'Baselines merged into main']
    ])
    expect(last().name).toBe(BASELINE_MERGE)
    expect(last().summary).toBe('2 baseline changes from `acme/web/feature` now apply to `acme/web/main`.')
    expect(report).toMatchObject({outcome: 'MERGED', ok: true})
    expect(logs).toContain('Baseline merge from PR #7: Baselines merged into main. 2 baseline changes from acme/web/feature now apply to acme/web/main.')
  })

  it('merges from the branch the gated run recorded', async () => {
    eyes.branches.add('acme/web/custom')
    checks = [{id: 1, name: VISUAL_TESTS, status: 'completed', conclusion: 'success', title: '', summary: encodeState({v: 1, batchId: 'head-sha', changed: [], branchName: 'acme/web/custom'})}]
    await runMerge(config(), deps(), 7)
    expect(eyes.merges).toEqual(['acme/web/custom → acme/web/main'])
  })

  it('does nothing for a PR closed without merging', async () => {
    pr.merged = false
    const report = await runMerge(config(), deps(), 7)
    expect(report).toEqual({pr: 7, ok: true, skipped: 'PR #7 closed without merging, so its baselines stay on their branch.'})
    expect(posted).toEqual([])
    expect(eyes.merges).toEqual([])
  })

  it('reports nothing to merge as success', async () => {
    eyes.mergeResult = {merged: false, conflicts: 0, changes: 0}
    expect(await runMerge(config(), deps(), 7)).toMatchObject({outcome: 'NOTHING_TO_MERGE', ok: true})
    expect(last()).toMatchObject({conclusion: 'success', title: 'Nothing to merge'})
  })

  it('fails on conflicts, saying where to resolve them and how to retry', async () => {
    eyes.mergeResult = {merged: false, conflicts: 3, changes: 0}
    expect(await runMerge(config(), deps(), 7)).toMatchObject({outcome: 'CONFLICTS', ok: false})
    expect(last()).toMatchObject({conclusion: 'failure', title: '3 baseline conflicts'})
    expect(last().summary).toContain('Resolve them in Eyes under **Compare & merge branches**')
    expect(last().summary).toContain('re-run this job to retry')
    expect(logs.some(l => l.startsWith('WARN Baseline merge from PR #7: 3 baseline conflicts.'))).toBe(true)
  })

  it('explains a key Eyes refuses', async () => {
    expect(await runMerge(config({mergeApiKey: 'RUN'}), deps(), 7)).toMatchObject({outcome: 'REFUSED', ok: false})
    expect(last()).toMatchObject({conclusion: 'failure', title: 'Eyes refused the baseline merge'})
    expect(last().summary).toContain('only Eyes **merge** keys')
  })

  it('posts a skip without a key, instead of failing silently', async () => {
    expect(await runMerge(config({mergeApiKey: undefined}), deps(), 7)).toMatchObject({outcome: 'NO_KEY', ok: false})
    expect(last()).toMatchObject({conclusion: 'failure', title: 'Baseline merge skipped'})
    expect(eyes.requests).toEqual([])
  })

  it('times out', async () => {
    eyes.mergeRunning = 1000
    expect(await runMerge(config({mergeTimeout: 0}), deps({sleep: () => new Promise(r => setTimeout(r, 5))}), 7)).toMatchObject({outcome: 'TIMED_OUT'})
    expect(last().title).toBe('Baseline merge timed out')
  })

  it('explains a missing branch when no gated run was found', async () => {
    eyes.branches.delete('acme/web/feature')
    expect(await runMerge(config(), deps(), 7)).toMatchObject({outcome: 'FAILED', ok: false})
    expect(last().title).toBe('Baseline merge failed')
    expect(last().summary).toContain("Eyes has no baseline branch 'acme/web/feature' or 'acme/web/main'. No visual test run")
  })
})

describe('mergeNotesBeforeTests', () => {
  const merge = (c: Partial<PostedCheck>): PostedCheck => ({id: 9, name: BASELINE_MERGE, status: 'completed', conclusion: 'success', title: 'Baselines merged into main', summary: '2 baseline changes from `a` now apply to `b`.', ...c})

  it('reports a successful merge into the branch', async () => {
    checks = [merge({})]
    const notes = await mergeNotesBeforeTests(deps().github, 'main-sha', 'main', deps().log, async () => {})
    expect(notes).toEqual([{pr: 7, ok: true, line: 'Baseline merge from PR #7: Baselines merged into main. 2 baseline changes from a now apply to b.'}])
    expect(mergeNotesMarkdown(notes)).toBe('')
  })

  it('warns about a failed merge, for the Visual tests check too', async () => {
    checks = [merge({conclusion: 'failure', title: '1 baseline conflict', url: 'https://github.com/acme/web/runs/9'})]
    const notes = await mergeNotesBeforeTests(deps().github, 'main-sha', 'main', deps().log, async () => {})
    expect(notes[0].ok).toBe(false)
    expect(logs[0]).toBe("WARN Baseline merge from PR #7: 1 baseline conflict. Until the baselines are merged, this build's tests may flag the changes the PR accepted. Details: https://github.com/acme/web/runs/9")
    expect(mergeNotesMarkdown(notes)).toContain('**Baseline merges**')
  })

  it('waits for a running merge before the tests start', async () => {
    let polls = 0
    const github = {
      ...deps().github,
      checks: async () => [merge(polls++ < 2 ? {status: 'in_progress', conclusion: null} : {})]
    }
    const notes = await mergeNotesBeforeTests(github, 'main-sha', 'main', deps().log, async () => {}, 60_000, 0)
    expect(notes[0].ok).toBe(true)
    expect(logs[0]).toContain('is running; waiting up to 60s')
  })

  it('ignores PRs into other branches', async () => {
    pr.baseRef = 'release'
    expect(await mergeNotesBeforeTests(deps().github, 'main-sha', 'main', deps().log, async () => {})).toEqual([])
  })
})
