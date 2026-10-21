/**
 * Posts results to GitHub with the workflow's `GITHUB_TOKEN` (SPEC §7.2): check runs by default (needs
 * `checks: write`), or commit statuses (`statuses: write`). Problems are logged, never thrown: reporting must not
 * fail the run.
 */
import * as core from '@actions/core'
import {getOctokit} from '@actions/github'
import {CheckResult, toStatus} from './checks.js'

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
