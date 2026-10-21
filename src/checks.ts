/**
 * The PR results (SPEC §7): names, states, titles and summaries, identical to the Jenkins plugin's so PRs look the same
 * whichever CI ran them.
 */
import {Verdict} from './design-review.js'
import {BatchResults, outcome, summary} from './results.js'

export const VISUAL_TESTS = 'Applitools / Visual tests'
export const DESIGN_REVIEW = 'Applitools / Design review'
export const BASELINE_MERGE = 'Applitools / Baseline merge'

export type Conclusion = 'success' | 'failure' | 'neutral' | 'skipped' | 'action_required'

export interface CheckResult {
  name: string
  status: 'in_progress' | 'completed'
  conclusion?: Conclusion
  title: string
  summary: string
  detailsUrl?: string
}

export type StatusState = 'pending' | 'success' | 'failure'

export interface CommitStatus {
  context: string
  state: StatusState
  description: string
  targetUrl?: string
}

export function visualTestsStarted(batchName: string): CheckResult {
  return {name: VISUAL_TESTS, status: 'in_progress', title: 'Running visual tests', summary: `Batch: ${batchName}`}
}

export function visualTestsCompleted(results: BatchResults): CheckResult {
  const o = outcome(results)
  const conclusion: Conclusion = o === 'PASSED' ? 'success' : o === 'CHANGES' ? 'action_required' : 'failure'
  const title =
    o === 'CHANGES'
      ? `${results.unresolved} visual change${results.unresolved === 1 ? '' : 's'} to review`
      : o === 'NO_RESULTS'
        ? 'No Eyes results'
        : summary(results)
  return {
    name: VISUAL_TESTS,
    status: 'completed',
    conclusion,
    title,
    summary: visualTestsSummary(results),
    detailsUrl: results.url
  }
}

/**
 * Results couldn't be collected. `blocking` (unreadable results) fails the check; otherwise (`waitForResults: false`)
 * it's neutral.
 */
export function visualTestsUnavailable(reason: string, blocking: boolean, logUrl?: string): CheckResult {
  const where = logUrl ? `the [workflow log](${logUrl})` : 'the workflow log'
  return {
    name: VISUAL_TESTS,
    status: 'completed',
    conclusion: blocking ? 'failure' : 'neutral',
    title: blocking ? "Couldn't read Eyes results" : 'Results not collected',
    summary: `${reason}\n\nSee ${where} for details.`
  }
}

/** `**[Review in Eyes](url)** · batch name`, the outcome line, then one row per test. */
export function visualTestsSummary(results: BatchResults): string {
  let md = ''
  if (results.url) {
    md += `**[Review in Eyes](${results.url})**`
    if (results.name) md += ` · ${escape(results.name)}`
    md += '\n\n'
  }
  md += `${summary(results)}\n`
  if (results.tests.length > 0) {
    md += '\n| Test | Browser / device | Status |\n| --- | --- | --- |\n'
    for (const test of results.tests) {
      const name = escape(test.name)
      md += `| ${test.url ? `[${name}](${test.url})` : name} | ${escape(test.environment)} | ${statusBadge(test.status)} |\n`
    }
  }
  return md
}

export function designReviewResult(verdict: Verdict, batchUrl?: string): CheckResult {
  // WAITING is completed + action_required, never in_progress: GitHub won't move a completed check back to in
  // progress, and this check is often completed (skipped) first and only later requested via the PR label.
  const conclusion: Conclusion = {
    NOT_REQUESTED: 'skipped',
    WAITING: 'action_required',
    APPROVED: 'success',
    CHANGES_REQUESTED: 'failure'
  }[verdict.state] as Conclusion
  return {
    name: DESIGN_REVIEW,
    status: 'completed',
    conclusion,
    title: verdict.title,
    summary: `${batchUrl ? `**[Review in Eyes](${batchUrl})**\n\n` : ''}${verdict.detail}`,
    detailsUrl: batchUrl
  }
}

/**
 * Commit statuses have four states and a 140-character description. Anything that should block a merge until a human
 * acts (in progress, action required) is pending; skipped and neutral pass.
 */
export function toStatus(check: CheckResult): CommitStatus {
  let state: StatusState
  if (check.status !== 'completed') {
    state = 'pending'
  } else {
    switch (check.conclusion) {
      case 'success':
      case 'neutral':
      case 'skipped':
        state = 'success'
        break
      case 'failure':
        state = 'failure'
        break
      default:
        state = 'pending'
    }
  }
  const description = check.title.length > 140 ? `${check.title.slice(0, 139)}…` : check.title
  return {context: check.name, state, description, targetUrl: check.detailsUrl}
}

function statusBadge(status: string): string {
  switch (status) {
    case 'passed':
    case 'new':
      return `✅ ${status}`
    case 'unresolved':
      return '⚠️ unresolved'
    case 'failed':
      return '❌ failed'
    default:
      return status
  }
}

/** Keeps names from breaking the markdown table. */
function escape(text: string): string {
  return text.replace(/\|/g, '\\|').replace(/\r?\n/g, ' ')
}
