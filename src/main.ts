import * as core from '@actions/core'
import * as exec from '@actions/exec'
import {context, getOctokit} from '@actions/github'
import {mkdtemp, rm, writeFile} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import path from 'node:path'
import {scmFromEvent, withOverrides} from './context.js'
import {EyesClient} from './eyes.js'
import {GateResult, runGate} from './gate.js'
import {GitHubReporter, Reporter} from './github.js'
import {readInputs} from './inputs.js'
import {OUTCOME_LABELS, outcome, summary} from './results.js'
import {visualTestsSummary} from './checks.js'

export async function main(): Promise<void> {
  try {
    const inputs = readInputs()
    const eventScm = scmFromEvent(context)
    const scm = withOverrides(eventScm, inputs.config.scm)
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
      runCommand: env => runCommand(inputs.run, inputs.workingDirectory, env),
      eyes: key => new EyesClient(inputs.config.serverUrl, key),
      reporter,
      log: {info: m => core.info(m), warning: m => core.warning(m)},
      env: process.env,
      scm: eventScm,
      fallbackLabel: `${context.workflow} #${context.runNumber}`,
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
  try {
    await core.summary.addRaw(md).write()
  } catch (e) {
    core.debug(`Could not write the job summary: ${e}`)
  }
}
