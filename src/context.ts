/**
 * PR context (SPEC §3.1) and batch identity (SPEC §3.2, §3.3).
 *
 * The commit MUST be the PR's head commit: on `pull_request` events `GITHUB_SHA` is a synthetic merge commit, so a
 * batch or check keyed on it lands nowhere.
 */
import {randomUUID} from 'node:crypto'

export interface ScmInfo {
  owner?: string
  repo?: string
  commitSha?: string
  /** Source branch for PRs, the pushed branch otherwise. */
  branch?: string
  prNumber?: number
  targetBranch?: string
  title?: string
  /** PR label names, from the event payload. */
  labels?: string[]
  /** The PR comes from a fork, so its test code is untrusted (SPEC §13a). */
  fork?: boolean
}

/** The parts of `@actions/github`'s context this needs (kept narrow so tests can pass plain objects). */
export interface EventContext {
  eventName: string
  sha: string
  ref: string
  repo: {owner: string; repo: string}
  payload: any
}

export interface ScmOverrides {
  repo?: string
  pullRequest?: string
  commit?: string
  branch?: string
  targetBranch?: string
}

export function scmFromEvent(ctx: EventContext): ScmInfo {
  const pr = ctx.payload?.pull_request
  if (pr) {
    return {
      owner: ctx.repo.owner,
      repo: ctx.repo.repo,
      commitSha: pr.head?.sha,
      branch: pr.head?.ref,
      prNumber: pr.number,
      targetBranch: pr.base?.ref,
      title: pr.title,
      labels: Array.isArray(pr.labels) ? pr.labels.map((l: {name?: string}) => String(l?.name ?? '')) : [],
      // A deleted fork has no head repository left (null).
      fork:
        pr.head?.repo === null ||
        (typeof pr.head?.repo?.full_name === 'string' &&
          pr.head.repo.full_name.toLowerCase() !== `${ctx.repo.owner}/${ctx.repo.repo}`.toLowerCase())
    }
  }
  return {
    owner: ctx.repo.owner,
    repo: ctx.repo.repo,
    commitSha: ctx.sha || undefined,
    branch: ctx.ref?.startsWith('refs/heads/') ? ctx.ref.slice('refs/heads/'.length) : undefined
  }
}

/** Explicit inputs win over the event (SPEC §3.1). */
export function withOverrides(scm: ScmInfo, o: ScmOverrides): ScmInfo {
  const out = {...scm}
  if (o.repo) {
    // It goes into GitHub API paths and Eyes branch names.
    if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(o.repo)) throw new Error(`\`repo\` must be owner/name, not '${o.repo}'`)
    const [owner, repo] = o.repo.split('/')
    out.owner = owner
    out.repo = repo
  }
  if (o.pullRequest) {
    const n = Number(o.pullRequest)
    if (Number.isInteger(n) && n > 0) out.prNumber = n
  }
  if (o.commit) out.commitSha = o.commit
  if (o.branch) out.branch = o.branch
  if (o.targetBranch) out.targetBranch = o.targetBranch
  return out
}

export function repoSlug(scm: ScmInfo): string | undefined {
  return scm.owner && scm.repo ? `${scm.owner}/${scm.repo}` : undefined
}

export function isPullRequest(scm: ScmInfo): boolean {
  return scm.prNumber !== undefined
}

export interface BatchSettings {
  batchId: string
  batchName: string
  branchName?: string
  parentBranchName?: string
  sequenceName: string
}

export interface BatchOverrides {
  batchId?: string
  batchName?: string
  branchName?: string
  parentBranchName?: string
}

/**
 * SPEC §3.2. Branch names use `owner/repo/branch`, the format Eyes' SCM integrations and the merge API use, so PR
 * baselines branch off (and merge back into) the target branch's baseline.
 *
 * @param fallbackLabel names the batch when there's no SCM info (e.g. "workflow #run")
 */
export function computeBatch(scm: ScmInfo, fallbackLabel: string, overrides: BatchOverrides = {}): BatchSettings {
  const slug = repoSlug(scm)
  const label = slug ?? fallbackLabel
  const prefix = slug ? `${slug}/` : ''

  let defaultName: string
  if (isPullRequest(scm)) {
    defaultName = `${label} PR #${scm.prNumber}${scm.title ? `: ${scm.title}` : ''}`
  } else if (scm.branch) {
    defaultName = `${label} ${scm.branch}`
  } else {
    defaultName = fallbackLabel
  }

  return {
    batchId: overrides.batchId || defaultBatchId(scm),
    batchName: overrides.batchName || defaultName,
    // A fork's branch can share a name with the repository's own (its main), so forks get one per PR (SPEC §3.2).
    branchName:
      overrides.branchName ||
      (scm.fork && isPullRequest(scm) ? `${prefix}pr-${scm.prNumber}` : scm.branch ? prefix + scm.branch : undefined),
    parentBranchName: overrides.parentBranchName || (scm.targetBranch ? prefix + scm.targetBranch : undefined),
    sequenceName: label
  }
}

/**
 * SPEC §3.2. A PR build is keyed on its head commit. A branch build adds the branch: the same commit is often built as a
 * PR and as a branch at once (a push to a PR's branch), or on two branches, and builds sharing a batch close and read
 * each other's results.
 */
function defaultBatchId(scm: ScmInfo): string {
  // No commit to key on: unique per run.
  if (!scm.commitSha) return randomUUID()
  return isPullRequest(scm) || !scm.branch ? scm.commitSha : `${scm.commitSha}-${scm.branch}`
}

export const ENV_MANAGED = 'APPLITOOLS_GATE_MANAGED'
/** The Jenkins plugin's marker; set too so test configs written for Jenkins work unchanged (SPEC §3.3). */
export const ENV_JENKINS_MANAGED = 'APPLITOOLS_JENKINS_MANAGED'
export const ENV_DESIGN_REVIEW = 'APPLITOOLS_DESIGN_REVIEW'

/** Environment for the gated command (SPEC §3.3). `existing` is the step's environment, for "unless already set". */
export function gateEnv(
  batch: BatchSettings,
  apiKey: string,
  serverUrl: string,
  judgeDiffs: boolean,
  existing: NodeJS.ProcessEnv
): Record<string, string> {
  const env: Record<string, string> = {
    APPLITOOLS_API_KEY: apiKey,
    APPLITOOLS_SERVER_URL: serverUrl,
    APPLITOOLS_BATCH_ID: batch.batchId,
    APPLITOOLS_BATCH_NAME: batch.batchName,
    APPLITOOLS_BATCH_SEQUENCE: batch.sequenceName,
    // The gate closes the batch once; SDK runners would otherwise close (and split) it.
    APPLITOOLS_DONT_CLOSE_BATCHES: 'true',
    [ENV_MANAGED]: 'true',
    [ENV_JENKINS_MANAGED]: 'true'
  }
  if (batch.branchName) env.APPLITOOLS_BRANCH_NAME = batch.branchName
  if (batch.parentBranchName) env.APPLITOOLS_PARENT_BRANCH_NAME = batch.parentBranchName
  if (judgeDiffs) {
    // The gate judges diffs, so SDKs shouldn't fail the command on them. Storybook's "nodiffs" still fails on
    // errors (e.g. a browser that won't launch).
    if (!existing.APPLITOOLS_EXITCODE) env.APPLITOOLS_EXITCODE = 'nodiffs'
    if (!existing.APPLITOOLS_FAIL_CYPRESS_ON_DIFF) env.APPLITOOLS_FAIL_CYPRESS_ON_DIFF = 'false'
  }
  return env
}
