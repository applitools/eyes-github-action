import * as core from '@actions/core'
import * as exec from '@actions/exec'
import {context, getOctokit} from '@actions/github'
import {mkdtemp, rm, writeFile} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import path from 'node:path'
import {ScmInfo, scmFromEvent, withOverrides} from './context.js'
import {EyesClient} from './eyes.js'
import {GateResult, runGate} from './gate.js'
import {checkServerUrl} from './security.js'
import {doctorMarkdown, runDoctor} from './doctor.js'
import {GitHubApi, GitHubReporter, Reporter} from './github.js'
import {MergeNote, mergeNotesBeforeTests, runMerge} from './merge.js'
import {retryUnmergedBaselines} from './merge-alerts.js'
import {ActionInputs, readInputs} from './inputs.js'
import {describeRefresh, runRefresh} from './refresh.js'
import {OUTCOME_LABELS, outcome, summary} from './results.js'
import {visualTestsSummary} from './checks.js'

export async function main(): Promise<void> {
  try {
    const eventScm = scmFromEvent(context)
    // Before reading inputs: a fork PR has no secrets, and "no API key" would hide the real reason.
    if (eventScm.fork && isRunMode() && core.getInput('allowForkPullRequests').trim().toLowerCase() !== 'true') {
      core.setFailed(
        `Pull request #${eventScm.prNumber} comes from a fork, so its test code isn't given the Eyes key and its visual ` +
          'tests don\'t run. A maintainer can push the branch to this repository instead, or set ' +
          '`allowForkPullRequests: true` if the fork\'s code may have the run key.'
      )
      return
    }
    const inputs = readInputs()
    if (inputs.mode === 'DOCTOR') return await doctor(inputs, eventScm)
    await checkServerUrl(inputs.config.serverUrl, inputs.allowHttp)
    const scm = withOverrides(eventScm, inputs.config.scm)
    if (inputs.mode === 'REFRESH') return await refresh(inputs, scm)
    if (inputs.mode === 'MERGE') return await merge(inputs, scm)
    const logUrl = `${context.serverUrl}/${context.repo.owner}/${context.repo.repo}/actions/runs/${context.runId}`

    let reporter: Reporter | undefined
    const alertProblems: string[] = []
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
      eyes: key => new EyesClient(inputs.config.serverUrl, key, inputs.config.apiKeyInQuery),
      reporter,
      log: {info: m => core.info(m), warning: m => core.warning(m)},
      env: process.env,
      scm: eventScm,
      fallbackLabel: `${context.workflow} #${context.runNumber}`,
      mergeNotes:
        octokit && scm.owner && scm.repo && scm.commitSha && scm.branch
          ? () => mergesIntoBranch(inputs, octokit, scm, logUrl, alertProblems)
          : undefined,
      currentLabels: async () => {
        if (!octokit || !scm.owner || !scm.repo || scm.prNumber === undefined) return undefined
        const pr = await octokit.rest.pulls.get({owner: scm.owner, repo: scm.repo, pull_number: scm.prNumber})
        return pr.data.labels.map(l => l.name)
      },
      logUrl
    })

    setOutputs(result)
    await writeJobSummary(result, alertProblems)
    if (result.warning) core.warning(result.warning)
    if (result.failure) core.setFailed(result.failure)
  } catch (e) {
    core.setFailed(e instanceof Error ? e.message : String(e))
  }
}

/**
 * A build of a branch, before its tests: wait for baseline merges from the PRs that produced this commit, then retry
 * the ones still labeled as not merged, posting the Baseline merge check on this commit when any were waiting.
 */
async function mergesIntoBranch(
  inputs: ActionInputs,
  octokit: ReturnType<typeof getOctokit>,
  scm: ScmInfo,
  runUrl: string,
  problems: string[]
): Promise<MergeNote[]> {
  const log = {info: (m: string) => core.info(m), warning: (m: string) => core.warning(m)}
  const github = new GitHubApi(octokit, scm.owner!, scm.repo!)
  const notes = await mergeNotesBeforeTests(github, scm.commitSha!, scm.branch!, log, ms => new Promise(r => setTimeout(r, ms)))
  let retry
  try {
    retry = await retryUnmergedBaselines(
      // Only a key given for merging: retrying with the run key would only report "Eyes refused".
      {...inputs.merge, mergeApiKey: inputs.keys.mergeApiKey},
      {github, alerts: github, eyes: key => new EyesClient(inputs.merge.serverUrl, key, inputs.config.apiKeyInQuery), log, repo: `${scm.owner}/${scm.repo}`},
      scm.branch!,
      inputs.alerts,
      {run: runUrl, pullRequest: n => `${context.serverUrl}/${scm.owner}/${scm.repo}/pull/${n}`}
    )
  } catch (e) {
    core.warning(`Couldn't look for merged PRs whose baselines still need merging: ${e instanceof Error ? e.message : e}`)
    return notes
  }
  if (retry.check && inputs.config.checks) {
    await new GitHubReporter(octokit, scm.owner!, scm.repo!, scm.commitSha!, inputs.githubReporting).publish(retry.check)
  }
  for (const n of retry.notes) {
    if (n.ok) core.info(n.line)
    else if (inputs.alerts.failBranch) core.error(n.line, {title: 'Eyes baselines not merged'})
    else core.warning(n.line)
  }
  for (const p of retry.problems) core.warning(p)
  problems.push(...retry.problems)
  const retried = new Set(retry.notes.map(n => n.pr))
  return [...notes.filter(n => !retried.has(n.pr)), ...retry.notes]
}

/** `mode: refresh`: the event's PR (or `pullRequest`), otherwise every open PR. No tests run. */
async function refresh(inputs: ActionInputs, scm: ScmInfo): Promise<void> {
  if (!inputs.githubToken) throw new Error('`mode: refresh` needs githubToken (the default is fine).')
  if (!scm.owner || !scm.repo) throw new Error('Repository unknown; set `repo:`.')
  const outcomes = await runRefresh(
    inputs.config,
    {
      github: new GitHubApi(getOctokit(inputs.githubToken), scm.owner, scm.repo),
      eyes: key => new EyesClient(inputs.config.serverUrl, key, inputs.config.apiKeyInQuery),
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
      eyes: key => new EyesClient(inputs.merge.serverUrl, key, inputs.config.apiKeyInQuery),
      log: {info: m => core.info(m), warning: m => core.warning(m)},
      repo: `${scm.owner}/${scm.repo}`,
      alerts: {
        github: new GitHubApi(octokit, scm.owner, scm.repo),
        options: inputs.alerts,
        runUrl: `${context.serverUrl}/${context.repo.owner}/${context.repo.repo}/actions/runs/${context.runId}`
      }
    },
    scm.prNumber
  )
  for (const p of report.alertProblems ?? []) core.warning(p)
  if (report.outcome) core.setOutput('baselineMerge', report.outcome)
  let md = report.skipped
    ? report.skipped
    : `### ${report.ok ? '✅' : '❌'} ${report.title}\n\n${report.summary}`
  if (!report.ok && inputs.alerts.comment && !report.alertProblems?.length) {
    md += `\n\nPR #${report.pr} is labeled \`eyes-baselines-not-merged\` and has a comment explaining this. Builds of its target branch retry the merge until it works.`
  }
  if (report.alertProblems?.length) md += `\n\n${report.alertProblems.map(p => `- ⚠️ ${p}`).join('\n')}`
  try {
    await core.summary.addRaw(`## Applitools baseline merge\n\n${md}\n`).write()
  } catch (e) {
    core.debug(`Could not write the job summary: ${e}`)
  }
  if (!report.ok) {
    core.error(`${report.title}: Eyes baselines from PR #${report.pr} weren't merged. See the job summary and the Applitools / Baseline merge check on the PR.`, {title: 'Eyes baselines not merged'})
    core.setFailed(`${report.title}: see the Applitools / Baseline merge check on PR #${report.pr}`)
  }
}

/** `mode: doctor`: setup checks in the job summary; fails the job if any fails. */
async function doctor(inputs: ActionInputs, scm: ScmInfo): Promise<void> {
  const octokit = inputs.githubToken ? getOctokit(inputs.githubToken) : undefined
  const items = await runDoctor(
    {
      serverUrl: inputs.config.serverUrl,
      allowHttp: inputs.allowHttp,
      ...inputs.keys,
      designers: inputs.config.designers,
      hideReviewers: inputs.config.hideReviewers
    },
    {
      eyes: key => new EyesClient(inputs.config.serverUrl, key, inputs.config.apiKeyInQuery),
      readPullRequests:
        octokit && scm.owner && scm.repo
          ? async () => void (await octokit.rest.pulls.list({owner: scm.owner!, repo: scm.repo!, per_page: 1}))
          : undefined
    }
  )
  for (const i of items) {
    const line = `${i.name}: ${i.detail}`
    if (i.status === 'ok') core.info(`✅ ${line}`)
    else if (i.status === 'warn') core.warning(line)
    else core.error(line)
  }
  try {
    await core.summary.addRaw(doctorMarkdown(items)).write()
  } catch (e) {
    core.debug(`Could not write the job summary: ${e}`)
  }
  const failed = items.filter(i => i.status === 'fail').length
  if (failed > 0) core.setFailed(`${failed} setup check${failed === 1 ? '' : 's'} failed; see the job summary.`)
}

function isRunMode(): boolean {
  return (core.getInput('mode').trim() || 'run').toLowerCase() === 'run'
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

async function writeJobSummary(result: GateResult, alertProblems: string[] = []): Promise<void> {
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
  if (alertProblems.length) md += `\n${alertProblems.map(p => `- ⚠️ ${p}`).join('\n')}\n`
  try {
    await core.summary.addRaw(md).write()
  } catch (e) {
    core.debug(`Could not write the job summary: ${e}`)
  }
}
