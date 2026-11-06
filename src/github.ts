/**
 * Posts results to GitHub with the workflow's `GITHUB_TOKEN` (SPEC §7.2): check runs by default (needs
 * `checks: write`), or commit statuses (`statuses: write`). Problems are logged, never thrown: reporting must not
 * fail the run.
 */
import * as core from '@actions/core'
import {getOctokit} from '@actions/github'
import {CheckResult, toStatus} from './checks.js'
import {MergeGitHub, MergedPullRequest} from './merge.js'
import {PostedCheck, PullRequest, RefreshGitHub} from './refresh.js'

export type Reporting = 'CHECKS' | 'STATUSES'

export interface Reporter {
  publish(result: CheckResult, externalId?: string): Promise<void>
}

type Octokit = ReturnType<typeof getOctokit>

export class GitHubReporter implements Reporter {
  /** Check runs created by this run, so "in progress" is completed in place instead of duplicated. */
  private readonly checkRunIds = new Map<string, number>()

  constructor(
    private readonly octokit: Octokit,
    private readonly owner: string,
    private readonly repo: string,
    private readonly sha: string,
    private readonly reporting: Reporting
  ) {}

  async publish(result: CheckResult, externalId?: string): Promise<void> {
    try {
      if (this.reporting === 'STATUSES') {
        const status = toStatus(result)
        await this.octokit.rest.repos.createCommitStatus({
          owner: this.owner,
          repo: this.repo,
          sha: this.sha,
          context: status.context,
          state: status.state,
          description: status.description,
          target_url: status.targetUrl
        })
        return
      }
      const body = {
        owner: this.owner,
        repo: this.repo,
        name: result.name,
        status: result.status,
        conclusion: result.status === 'completed' ? result.conclusion : undefined,
        completed_at: result.status === 'completed' ? new Date().toISOString() : undefined,
        details_url: result.detailsUrl,
        external_id: externalId,
        output: {title: result.title, summary: truncate(result.summary)}
      }
      const id = this.checkRunIds.get(result.name)
      if (id !== undefined) {
        await this.octokit.rest.checks.update({...body, check_run_id: id})
      } else {
        const created = await this.octokit.rest.checks.create({
          ...body,
          head_sha: this.sha,
          started_at: new Date().toISOString()
        })
        this.checkRunIds.set(result.name, created.data.id)
      }
    } catch (e) {
      core.warning(`Could not publish '${result.name}': ${describeError(e)}`)
    }
  }
}

/**
 * Reads PRs and check runs and updates checks, for refreshes and baseline merges. Unlike publishing, errors are thrown
 * to the caller.
 */
export class GitHubApi implements RefreshGitHub, MergeGitHub {
  constructor(
    private readonly octokit: Octokit,
    private readonly owner: string,
    private readonly repo: string
  ) {}

  async pullRequests(only?: number): Promise<PullRequest[]> {
    const {owner, repo} = this
    const toRef = (pr: {number: number; head: {sha: string}; labels: {name?: string}[]}): PullRequest => ({
      number: pr.number,
      headSha: pr.head.sha,
      labels: pr.labels.flatMap(l => (l.name ? [l.name] : []))
    })
    if (only !== undefined) {
      const {data} = await this.octokit.rest.pulls.get({owner, repo, pull_number: only})
      return data.state === 'open' ? [toRef(data)] : []
    }
    const prs = await this.octokit.paginate(this.octokit.rest.pulls.list, {owner, repo, state: 'open', per_page: 100})
    return prs.map(toRef)
  }

  async pullRequest(n: number): Promise<MergedPullRequest> {
    const {data} = await this.octokit.rest.pulls.get({owner: this.owner, repo: this.repo, pull_number: n})
    return toMerged(data)
  }

  async pullRequestsForCommit(sha: string): Promise<MergedPullRequest[]> {
    const {data} = await this.octokit.rest.repos.listPullRequestsAssociatedWithCommit({
      owner: this.owner,
      repo: this.repo,
      commit_sha: sha
    })
    return data.map(toMerged)
  }

  async checks(sha: string, names: string[]): Promise<PostedCheck[]> {
    const runs = []
    for (const name of names) {
      const {data} = await this.octokit.rest.checks.listForRef({
        owner: this.owner,
        repo: this.repo,
        ref: sha,
        check_name: name,
        filter: 'all',
        per_page: 100
      })
      runs.push(...data.check_runs)
    }
    return runs.map(r => ({
      id: r.id,
      name: r.name,
      appId: r.app?.id,
      status: r.status,
      conclusion: r.conclusion,
      title: r.output.title,
      summary: r.output.summary,
      url: r.html_url ?? undefined
    }))
  }

  async update(id: number, result: CheckResult): Promise<void> {
    await this.octokit.rest.checks.update({
      owner: this.owner,
      repo: this.repo,
      check_run_id: id,
      status: 'completed',
      conclusion: result.conclusion,
      completed_at: new Date().toISOString(),
      details_url: result.detailsUrl,
      output: {title: result.title, summary: truncate(result.summary)}
    })
  }

  async create(sha: string, result: CheckResult, externalId: string): Promise<void> {
    await this.octokit.rest.checks.create({
      owner: this.owner,
      repo: this.repo,
      head_sha: sha,
      name: result.name,
      status: 'completed',
      conclusion: result.conclusion,
      completed_at: new Date().toISOString(),
      details_url: result.detailsUrl,
      external_id: externalId,
      output: {title: result.title, summary: truncate(result.summary)}
    })
  }
}

function toMerged(pr: {
  number: number
  title: string
  merged_at: string | null
  head: {sha: string; ref: string; repo: {full_name: string} | null}
  base: {ref: string; repo: {full_name: string}}
}): MergedPullRequest {
  return {
    number: pr.number,
    title: pr.title,
    merged: pr.merged_at !== null,
    headSha: pr.head.sha,
    headRef: pr.head.ref,
    baseRef: pr.base.ref,
    fork: pr.head.repo?.full_name.toLowerCase() !== pr.base.repo.full_name.toLowerCase()
  }
}

/** Check summaries are limited to 65535 characters. */
function truncate(summary: string): string {
  const max = 65_000
  return summary.length > max ? `${summary.slice(0, max)}\n\n… (truncated)` : summary
}

function describeError(e: unknown): string {
  const status = (e as {status?: number}).status
  const message = e instanceof Error ? e.message : String(e)
  if (status === 403) {
    return `${message}. Give the workflow \`permissions: checks: write\` (or \`statuses: write\` with githubReporting: STATUSES). Pull requests from forks get a read-only token.`
  }
  return message
}
