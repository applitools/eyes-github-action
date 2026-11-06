import * as core from '@actions/core'
import * as exec from '@actions/exec'
import {context, getOctokit} from '@actions/github'
import {mkdtemp, rm, writeFile} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import path from 'node:path'
import {ScmInfo, scmFromEvent, withOverrides} from './context.js'
import {EyesClient} from './eyes.js'
import {GateResult, runGate} from './gate.js'
import {GitHubApi, GitHubReporter, Reporter} from './github.js'
import {mergeNotesBeforeTests, runMerge} from './merge.js'
import {ActionInputs, readInputs} from './inputs.js'
import {describeRefresh, runRefresh} from './refresh.js'
import {OUTCOME_LABELS, outcome, summary} from './results.js'
import {visualTestsSummary} from './checks.js'

export async function main(): Promise<void> {
  try {
    const inputs = readInputs()
    const eventScm = scmFromEvent(context)
    const scm = withOverrides(eventScm, inputs.config.scm)
    if (inputs.mode === 'REFRESH') return await refresh(inputs, scm)
    if (inputs.mode === 'MERGE') return await merge(inputs, scm)
    const logUrl = `${context.serverUrl}/${context.repo.owner}/${context.repo.repo}/actions/runs/${context.runId}`

    let reporter: Reporter | undefined
    const octokit = inputs.githubToken ? getOctokit(inputs.githubToken) : undefined
    if (inputs.config.checks) {
      if (!inputs.githubToken) {
        core.warning('No githubToken, so results will not be posted to the pull request.')
      } else if (!scm.owner || !scm.repo || !scm.commitSha) {
        core.warning('Repository or commit unknown; results will not be posted. Set `repo:` and `commit:`.')
      } else {
        reporter = new GitHubReporter(
          octokit!,
          scm.owner,
          scm.repo,
          scm.commitSha,
          inputs.githubReporting
        )
      }
    }

    const result = await runGate(inputs.config, {
      runCommand: env => runCommand(inputs.run!, inputs.workingDirectory, env),
      eyes: key => new EyesClient(inputs.config.serverUrl, key),
      reporter,
      log: {info: m => core.info(m), warning: m => core.warning(m)},
      env: process.env,
      scm: eventScm,
      fallbackLabel: `${context.workflow} #${context.runNumber}`,
      mergeNotes:
        octokit && scm.owner && scm.repo && scm.commitSha && scm.branch
          ? () =>
              mergeNotesBeforeTests(
                new GitHubApi(octokit, scm.owner!, scm.repo!),
                scm.commitSha!,
                scm.branch!,
                {info: m => core.info(m), warning: m => core.warning(m)},
                ms => new Promise(r => setTimeout(r, ms))
              )
          : undefined,
      currentLabels: async () => {
        if (!octokit || !scm.owner || !scm.repo || scm.prNumber === undefined) return undefined
        const pr = await octokit.rest.pulls.get({owner: scm.owner, repo: scm.repo, pull_number: scm.prNumber})
        return pr.data.labels.map(l => l.name)
      },
      logUrl
    })

    setOutputs(result)
    await writeJobSummary(result)
    if (result.warning) core.warning(result.warning)
    if (result.failure) core.setFailed(result.failure)
  } catch (e) {
    core.setFailed(e instanceof Error ? e.message : String(e))
  }
}

/** `mode: refresh`: the event's PR (or `pullRequest`), otherwise every open PR. No tests run. */
async function refresh(inputs: ActionInputs, scm: ScmInfo): Promise<void> {
  if (!inputs.githubToken) throw new Error('`mode: refresh` needs githubToken (the default is fine).')
  if (!scm.owner || !scm.repo) throw new Error('Repository unknown; set `repo:`.')
  const outcomes = await runRefresh(
    inputs.config,
    {
      github: new GitHubApi(getOctokit(inputs.githubToken), scm.owner, scm.repo),
      eyes: key => new EyesClient(inputs.config.serverUrl, key),
      log: {info: m => core.info(m), warning: m => core.warning(m)},
      env: process.env
    },
    scm.prNumber
  )
  const lines = outcomes.map(o => `- ${describeRefresh(o)}`)
  try {
    await core.summary.addRaw(`## Applitools refresh\n\n${lines.join('\n') || 'No open pull requests.'}\n`).write()
  } catch (e) {
    core.debug(`Could not write the job summary: ${e}`)
  }
}

/** `mode: merge`: merge a merged PR's Eyes baselines into its target branch. Fails the job unless that worked. */
async function merge(inputs: ActionInputs, scm: ScmInfo): Promise<void> {
  if (!inputs.githubToken) throw new Error('`mode: merge` needs githubToken (the default is fine).')
  if (!scm.owner || !scm.repo) throw new Error('Repository unknown; set `repo:`.')
  if (scm.prNumber === undefined) {
    throw new Error('`mode: merge` runs on `pull_request: closed` events, or with `pullRequest:` set.')
  }
  const octokit = getOctokit(inputs.githubToken)
  const report = await runMerge(
    inputs.merge,
    {
      github: new GitHubApi(octokit, scm.owner, scm.repo),
      reporter: sha =>
        inputs.config.checks ? new GitHubReporter(octokit, scm.owner!, scm.repo!, sha, 'CHECKS') : undefined,
      eyes: key => new EyesClient(inputs.merge.serverUrl, key),
      log: {info: m => core.info(m), warning: m => core.warning(m)},
      repo: `${scm.owner}/${scm.repo}`
    },
    scm.prNumber
  )
  if (report.outcome) core.setOutput('baselineMerge', report.outcome)
  const md = report.skipped
    ? report.skipped
    : `### ${report.ok ? '✅' : '❌'} ${report.title}\n\n${report.summary}`
  try {
    await core.summary.addRaw(`## Applitools baseline merge\n\n${md}\n`).write()
  } catch (e) {
    core.debug(`Could not write the job summary: ${e}`)
  }
  if (!report.ok) core.setFailed(`${report.title}: see the Applitools / Baseline merge check on PR #${report.pr}`)
}

/**
 * Runs the user's command with bash, like a `run:` step (`bash --noprofile --norc -eo pipefail`). Action inputs
 * (`INPUT_*`, which include the GitHub token) are kept out of the command's environment.
 */
async function runCommand(command: string, cwd: string | undefined, extra: Record<string, string>): Promise<number> {
  const dir = await mkdtemp(path.join(process.env.RUNNER_TEMP || tmpdir(), 'applitools-'))
  const script = path.join(dir, 'run.sh')
  await writeFile(script, command, 'utf8')
  const env: Record<string, string> = {}
  for (const [k, v] of Object.entries(process.env)) {
    if (v !== undefined && !k.startsWith('INPUT_')) env[k] = v
  }
  Object.assign(env, extra)
  try {
    core.startGroup('Run visual tests')
    return await exec.exec('bash', ['--noprofile', '--norc', '-eo', 'pipefail', script], {
      cwd,
      env,
      ignoreReturnCode: true
    })
  } finally {
    core.endGroup()
    await rm(dir, {recursive: true, force: true})
  }
}

function setOutputs(result: GateResult): void {
  core.setOutput('batchId', result.batchId)
  if (result.results) {
    core.setOutput('outcome', outcome(result.results))
    core.setOutput('summary', summary(result.results))
    core.setOutput('batchUrl', result.results.url ?? '')
  }
  if (result.design) core.setOutput('designReview', result.design.state)
}

async function writeJobSummary(result: GateResult): Promise<void> {
  // Markdown headings: an HTML heading swallows the markdown that follows it unless a blank line intervenes.
  let md = '## Applitools\n\n'
  if (result.results) {
    md += `### ${OUTCOME_LABELS[outcome(result.results)]}\n\n${visualTestsSummary(result.results)}\n`
  } else if (result.problem) {
    md += `Couldn't read Eyes results: ${result.problem}\n\n`
  }
  if (result.design) md += `### Design review: ${result.design.title}\n\n${result.design.detail}\n`
  if (result.mergeNotes?.length) {
    md += `### Baseline merges into this branch\n\n${result.mergeNotes.map(n => `- ${n.ok ? '' : '⚠️ '}${n.line}`).join('\n')}\n`
  }
  try {
    await core.summary.addRaw(md).write()
  } catch (e) {
    core.debug(`Could not write the job summary: ${e}`)
  }
}
