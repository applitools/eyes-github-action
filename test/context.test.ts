import {describe, expect, it} from 'vitest'
import {EventContext, computeBatch, gateEnv, scmFromEvent, withOverrides} from '../src/context.js'
import {decodeState, encodeState} from '../src/state.js'

const prEvent: EventContext = {
  eventName: 'pull_request',
  sha: 'merge-commit-sha',
  ref: 'refs/pull/7/merge',
  repo: {owner: 'acme', repo: 'web'},
  payload: {
    pull_request: {
      number: 7,
      title: 'New header',
      head: {sha: 'head-sha', ref: 'feature/header', repo: {full_name: 'acme/web'}},
      base: {ref: 'main'},
      labels: [{name: 'Design-Review'}, {name: 'bug'}]
    }
  }
}

describe('scmFromEvent (SPEC §3.1)', () => {
  it('uses the PR head commit, never the merge commit', () => {
    expect(scmFromEvent(prEvent)).toEqual({
      owner: 'acme',
      repo: 'web',
      commitSha: 'head-sha',
      branch: 'feature/header',
      prNumber: 7,
      targetBranch: 'main',
      title: 'New header',
      labels: ['Design-Review', 'bug'],
      fork: false
    })
  })

  it('gives fork PRs their own Eyes branch: a fork\'s main must not test against the repo\'s main', () => {
    const fork = (repo: unknown) =>
      scmFromEvent({...prEvent, payload: {pull_request: {...prEvent.payload.pull_request, head: {sha: 'h', ref: 'main', repo}}}})
    expect(fork({full_name: 'mallory/web'}).fork).toBe(true)
    expect(fork(null).fork).toBe(true)
    expect(fork({full_name: 'ACME/web'}).fork).toBe(false)
    expect(computeBatch(fork({full_name: 'mallory/web'}), 'wf #1').branchName).toBe('acme/web/pr-7')
  })

  it('refuses a repo override that isn\'t owner/name', () => {
    expect(() => withOverrides({}, {repo: 'acme/web/../x'})).toThrow('`repo` must be owner/name')
  })

  it('reads branch builds from the ref', () => {
    expect(
      scmFromEvent({eventName: 'push', sha: 'abc', ref: 'refs/heads/release/2.0', repo: {owner: 'a', repo: 'b'}, payload: {}})
    ).toEqual({owner: 'a', repo: 'b', commitSha: 'abc', branch: 'release/2.0'})
  })

  it('applies explicit overrides', () => {
    const scm = withOverrides(scmFromEvent(prEvent), {repo: 'other/repo', commit: 'c1', pullRequest: '9', targetBranch: 'dev'})
    expect(scm).toMatchObject({owner: 'other', repo: 'repo', commitSha: 'c1', prNumber: 9, targetBranch: 'dev'})
  })
})

describe('computeBatch (SPEC §3.2)', () => {
  it('PR: head SHA, PR batch name, owner/repo branch names', () => {
    expect(computeBatch(scmFromEvent(prEvent), 'wf #1')).toEqual({
      batchId: 'head-sha',
      batchName: 'acme/web PR #7: New header',
      branchName: 'acme/web/feature/header',
      parentBranchName: 'acme/web/main',
      sequenceName: 'acme/web'
    })
  })

  it('branch build: no parent branch', () => {
    expect(computeBatch({owner: 'a', repo: 'b', commitSha: 's', branch: 'main'}, 'wf #1')).toEqual({
      batchId: 's',
      batchName: 'a/b main',
      branchName: 'a/b/main',
      parentBranchName: undefined,
      sequenceName: 'a/b'
    })
  })

  it('no SCM info: random ID per run, label name, no branches', () => {
    const a = computeBatch({}, 'Visual #12')
    const b = computeBatch({}, 'Visual #12')
    expect(a.batchId).toMatch(/^[0-9a-f-]{36}$/)
    expect(a.batchId).not.toBe(b.batchId)
    expect(a).toMatchObject({batchName: 'Visual #12', branchName: undefined, sequenceName: 'Visual #12'})
  })

  it('overrides win', () => {
    const batch = computeBatch(scmFromEvent(prEvent), 'x', {batchId: 'id', batchName: 'n', branchName: 'b', parentBranchName: 'p'})
    expect(batch).toMatchObject({batchId: 'id', batchName: 'n', branchName: 'b', parentBranchName: 'p'})
  })
})

describe('gateEnv (SPEC §3.3)', () => {
  const batch = computeBatch(scmFromEvent(prEvent), 'x')

  it('sets the batch, branch, key and gate markers', () => {
    expect(gateEnv(batch, 'KEY', 'https://eyes', true, {})).toEqual({
      APPLITOOLS_API_KEY: 'KEY',
      APPLITOOLS_SERVER_URL: 'https://eyes',
      APPLITOOLS_BATCH_ID: 'head-sha',
      APPLITOOLS_BATCH_NAME: 'acme/web PR #7: New header',
      APPLITOOLS_BATCH_SEQUENCE: 'acme/web',
      APPLITOOLS_BRANCH_NAME: 'acme/web/feature/header',
      APPLITOOLS_PARENT_BRANCH_NAME: 'acme/web/main',
      APPLITOOLS_DONT_CLOSE_BATCHES: 'true',
      APPLITOOLS_GATE_MANAGED: 'true',
      APPLITOOLS_JENKINS_MANAGED: 'true',
      APPLITOOLS_EXITCODE: 'nodiffs',
      APPLITOOLS_FAIL_CYPRESS_ON_DIFF: 'false'
    })
  })

  it('leaves SDK exit settings alone when already set or when not judging diffs', () => {
    const env = gateEnv(batch, 'K', 'u', true, {APPLITOOLS_EXITCODE: 'false'})
    expect(env.APPLITOOLS_EXITCODE).toBeUndefined()
    expect(env.APPLITOOLS_FAIL_CYPRESS_ON_DIFF).toBe('false')
    const off = gateEnv(batch, 'K', 'u', false, {})
    expect(off.APPLITOOLS_EXITCODE).toBeUndefined()
    expect(off.APPLITOOLS_FAIL_CYPRESS_ON_DIFF).toBeUndefined()
  })
})

describe('gate state in the check summary', () => {
  it('round-trips through an HTML comment, even with "--" in values', () => {
    const state = {v: 1 as const, batchId: 'sha', eyesBatchId: 'e1', changed: ['a--b'], expectApps: ['Web --> App']}
    const summary = `**[Review in Eyes](u)**\n\ntable${encodeState(state)}`
    expect(/<!-- applitools-gate-state (.*) -->/.exec(summary)![1]).not.toContain('--')
    expect(decodeState(summary)).toEqual(state)
  })

  it('ignores summaries without state', () => {
    expect(decodeState('no state')).toBeUndefined()
    expect(decodeState(undefined)).toBeUndefined()
    expect(decodeState('<!-- applitools-gate-state {"v":2,"batchId":"x"} -->')).toBeUndefined()
  })
})
