import {afterEach, beforeEach, describe, expect, it} from 'vitest'
import {BASELINE_MERGE, CheckResult} from '../src/checks.js'
import {EyesClient} from '../src/eyes.js'
import {ALERT_MARKER, AlertGitHub, AlertOptions, IssueComment, UNMERGED_LABEL, retryUnmergedBaselines} from '../src/merge-alerts.js'
import {MergeDeps, MergedPullRequest, runMerge} from '../src/merge.js'
import {FakeEyes} from './fake-eyes.js'

let eyes: FakeEyes
let pr: MergedPullRequest
let comments: IssueComment[]
let writes: string[]
let posted: CheckResult[]
let logs: string[]
let failWrites: number | undefined

const on: AlertOptions = {comment: true, failBranch: true}
const RUN = 'https://github.com/acme/web/actions/runs/42'

function alertGitHub(): AlertGitHub {
  const write = async (what: string) => {
    if (failWrites) throw Object.assign(new Error('Resource not accessible by integration'), {status: failWrites})
    writes.push(what)
  }
  return {
    comments: async () => comments,
    createComment: async (_n, body) => {
      await write('create comment')
      comments.push({id: comments.length + 1, body})
    },
    updateComment: async (id, body) => {
      await write('update comment')
      comments.find(c => c.id === id)!.body = body
    },
    addLabel: async (_n, label) => {
      await write(`add ${label}`)
      pr.labels = [...(pr.labels ?? []), label]
    },
    removeLabel: async (_n, label) => {
      await write(`remove ${label}`)
      pr.labels = pr.labels?.filter(l => l !== label)
    },
    labeledMergedPullRequests: async (base, label) =>
      pr.merged && pr.baseRef === base && pr.labels?.includes(label) ? [{...pr}] : []
  }
}

function deps(options = on): MergeDeps {
  return {
    github: {pullRequest: async () => ({...pr}), pullRequestsForCommit: async () => [], checks: async () => []},
    reporter: () => ({publish: async r => void posted.push(r)}),
    eyes: key => new EyesClient(eyes.url, key),
    log: {info: m => logs.push(m), warning: m => logs.push(`WARN ${m}`)},
    repo: 'acme/web',
    sleep: async () => {},
    pollMs: 0,
    alerts: {github: alertGitHub(), options, runUrl: RUN}
  }
}

const config = (mergeApiKey: string | undefined = 'MERGE') => ({serverUrl: eyes.url, mergeApiKey, mergeTimeout: 600})

function retry(options = on, mergeApiKey: string | null = 'MERGE') {
  const d = deps(options)
  return retryUnmergedBaselines({...config(), mergeApiKey: mergeApiKey ?? undefined}, {...d, alerts: d.alerts!.github}, 'main', options, {
    run: 'https://github.com/acme/web/actions/runs/43',
    pullRequest: n => `https://github.com/acme/web/pull/${n}`
  })
}

beforeEach(async () => {
  eyes = await new FakeEyes().start()
  eyes.keys.set('MERGE', {read: true, merge: true})
  eyes.keys.set('RUN', {read: false})
  eyes.branches.add('acme/web/feature').add('acme/web/main')
  pr = {number: 7, title: 'New header', merged: true, headSha: 'head-sha', headRef: 'feature', baseRef: 'main', labels: []}
  comments = []
  writes = []
  posted = []
  logs = []
  failWrites = undefined
})

afterEach(() => eyes.stop())

describe('a failed merge comments on and labels the PR', () => {
  it('explains conflicts in one comment, and says what happens until they are resolved', async () => {
    eyes.mergeResult = {merged: false, conflicts: 2, changes: 0}
    const report = await runMerge(config(), deps(), 7)

    expect(report).toMatchObject({outcome: 'CONFLICTS', ok: false, alertProblems: []})
    expect(pr.labels).toEqual([UNMERGED_LABEL])
    expect(comments).toHaveLength(1)
    expect(comments[0].body).toBe(
      `${ALERT_MARKER}\n### ⚠️ Eyes baselines from this PR weren't merged into \`main\`\n\n` +
        '**2 baseline conflicts**\n\n' +
        'The same checkpoints changed on `main` too. In Eyes, open **Compare & merge branches**, compare ' +
        '`acme/web/feature` → `acme/web/main`, resolve the conflicts, then merge.\n\n' +
        'Until then, builds of `main` fail the **Applitools / Baseline merge** check, and their tests may flag the ' +
        "changes this PR accepted. The next run on `main` after it's fixed confirms the merge and updates this comment.\n"
    )
  })

  it('edits its comment only when the reason changes, never adding another', async () => {
    eyes.mergeResult = {merged: false, conflicts: 2, changes: 0}
    await runMerge(config(), deps(), 7)
    await runMerge(config(), deps(), 7)
    expect(writes).toEqual([`add ${UNMERGED_LABEL}`, 'create comment'])

    await runMerge(config('RUN'), deps(), 7)
    expect(writes.at(-1)).toBe('update comment')
    expect(comments).toHaveLength(1)
    expect(comments[0].body).toContain('**Eyes refused the baseline merge**')
  })

  it('a later successful re-run removes the label and turns the comment ✅', async () => {
    eyes.mergeResult = {merged: false, conflicts: 2, changes: 0}
    await runMerge(config(), deps(), 7)
    eyes.mergeResult = {merged: true, conflicts: 0, changes: 3}
    expect(await runMerge(config(), deps(), 7)).toMatchObject({outcome: 'MERGED', ok: true})

    expect(pr.labels).toEqual([])
    expect(comments[0].body).toBe(
      `${ALERT_MARKER}\n### ✅ Eyes baselines from this PR are merged into \`main\`\n\n` +
        `3 baseline changes from \`acme/web/feature\` now apply to \`acme/web/main\`. Merged by [this run](${RUN}).\n`
    )
  })

  it('leaves a PR that merged cleanly alone', async () => {
    await runMerge(config(), deps(), 7)
    expect(writes).toEqual([])
  })

  it('only reports when baselineMergeAlerts is off', async () => {
    eyes.mergeResult = {merged: false, conflicts: 2, changes: 0}
    expect(await runMerge(config(), deps({comment: false, failBranch: true}), 7)).toMatchObject({ok: false})
    expect(writes).toEqual([])
  })

  it('says which permission is missing, and that the branch builds then won\'t retry', async () => {
    eyes.mergeResult = {merged: false, conflicts: 2, changes: 0}
    failWrites = 403
    const report = await runMerge(config(), deps(), 7)
    expect(report.alertProblems).toEqual([
      `Couldn't label PR #7 \`${UNMERGED_LABEL}\` (HTTP 403). Give the workflow \`permissions: pull-requests: write\`. Without the label, builds of the target branch won't retry this merge.`,
      "Couldn't comment on PR #7 (HTTP 403). Give the workflow `permissions: pull-requests: write`."
    ])
    expect(posted.at(-1)).toMatchObject({conclusion: 'failure', title: '2 baseline conflicts'})
  })
})

describe('builds of the target branch retry until the merge works', () => {
  beforeEach(async () => {
    eyes.mergeResult = {merged: false, conflicts: 2, changes: 0}
    await runMerge(config(), deps(), 7)
    writes = []
    eyes.merges.length = 0
  })

  it('posts no check when no PR is waiting', async () => {
    pr.labels = []
    expect(await retry()).toEqual({notes: [], problems: []})
    expect(eyes.merges).toEqual([])
  })

  it('fails the branch check while the conflicts remain, leaving the unchanged comment alone', async () => {
    const report = await retry()
    expect(eyes.merges).toEqual(['acme/web/feature → acme/web/main'])
    expect(report.check).toMatchObject({
      name: BASELINE_MERGE,
      conclusion: 'failure',
      title: 'Baselines from PR #7 not merged into main',
      detailsUrl: 'https://github.com/acme/web/actions/runs/43'
    })
    expect(report.check!.summary).toContain('❌ [PR #7](https://github.com/acme/web/pull/7): **2 baseline conflicts**.')
    expect(report.check!.summary).toContain('Every build of `main` retries the merge')
    expect(report.notes).toEqual([
      expect.objectContaining({pr: 7, ok: false, line: expect.stringMatching(/^Eyes baselines from PR #7 still aren't merged into main: 2 baseline conflicts\./)})
    ])
    expect(writes).toEqual([])
  })

  it('posts it as neutral with failBranchOnUnmergedBaselines off', async () => {
    expect((await retry({comment: true, failBranch: false})).check?.conclusion).toBe('neutral')
  })

  it('clears everything once the conflicts are resolved in Eyes', async () => {
    eyes.mergeResult = {merged: false, conflicts: 0, changes: 0}
    const report = await retry()
    expect(report.check).toMatchObject({conclusion: 'success', title: 'Baselines from PR #7 merged into main'})
    expect(pr.labels).toEqual([])
    expect(comments[0].body).toContain('### ✅ Eyes baselines from this PR are merged into `main`')
    expect(comments[0].body).toContain(
      'Nothing was left to merge from `acme/web/feature` into `acme/web/main`. Confirmed by [this run](https://github.com/acme/web/actions/runs/43).'
    )
    expect(report.notes[0]).toMatchObject({ok: true})
  })

  it("doesn't retry without a merge key, so the comment keeps the real reason", async () => {
    const report = await retry(on, null)
    expect(eyes.merges).toEqual([])
    expect(report.check).toMatchObject({conclusion: 'failure'})
    expect(report.check!.summary).toContain('no Eyes merge key to retry with')
    expect(writes).toEqual([])
    expect(comments[0].body).toContain('**2 baseline conflicts**')
  })
})
