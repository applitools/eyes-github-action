/**
 * The "Applitools / Design review" gate (SPEC §6). When a PR is flagged for design review, it passes only once every
 * visual change in the run has been accepted in Eyes, by someone on the designers list if there is one. When it isn't
 * flagged, the check is posted as skipped, so it can still be a required check.
 */
import {Designers, allows, describe, isAnyone} from './designers.js'
import {BatchResults, summary} from './results.js'

export type DesignState = 'NOT_REQUESTED' | 'WAITING' | 'APPROVED' | 'CHANGES_REQUESTED'

export interface Verdict {
  state: DesignState
  title: string
  detail: string
}

export interface DesignInputs {
  /** `designReview` option: forces design review on or off. */
  option?: boolean
  /** `APPLITOOLS_DESIGN_REVIEW` environment variable. */
  env?: boolean
  /** Whether the PR has the design-review label (undefined when not a PR). */
  labelPresent?: boolean
  byDefault: boolean
}

/** SPEC §6.1, first match wins. */
export function isRequired(inputs: DesignInputs): boolean {
  if (inputs.option !== undefined) return inputs.option
  if (inputs.env !== undefined) return inputs.env
  if (inputs.labelPresent) return true
  return inputs.byDefault
}

/** True when the option or env decided, so label events must be ignored (SPEC §6.1). */
export function isForced(inputs: DesignInputs): boolean {
  return inputs.option !== undefined || inputs.env !== undefined
}

/**
 * SPEC §6.2, first match wins.
 *
 * @param changedTestIds tests that had visual changes when the run finished
 * @param approvers for each changed test that's now accepted, who accepted it (only needed with designers)
 */
export function evaluate(
  required: boolean,
  label: string,
  results: BatchResults,
  changedTestIds: string[],
  approvers: Map<string, Set<string>>,
  designers: Designers
): Verdict {
  if (!required) {
    return {
      state: 'NOT_REQUESTED',
      title: 'Not requested',
      detail: `Add the \`${label}\` label to this pull request to require a designer's approval.`
    }
  }
  if (results.failed > 0) {
    const changed = new Set(changedTestIds)
    const rejected = results.tests.some(t => t.id !== undefined && changed.has(t.id) && t.status === 'failed')
    return rejected
      ? {
          state: 'CHANGES_REQUESTED',
          title: 'Changes requested',
          detail: 'A reviewer rejected visual changes in Eyes. Push a fix to run the tests again.'
        }
      : {
          state: 'CHANGES_REQUESTED',
          title: 'Visual tests failed',
          detail: `${summary(results)}. Fix the tests before design review.`
        }
  }
  if (results.unresolved > 0) {
    return {
      state: 'WAITING',
      title: 'Waiting for design review',
      detail: `${plural(results.unresolved, 'visual change')} to review in Eyes${isAnyone(designers) ? '.' : ' by a designer.'}`
    }
  }
  if (changedTestIds.length === 0) {
    return {state: 'APPROVED', title: 'No visual changes', detail: 'Nothing in this build needs design review.'}
  }
  if (isAnyone(designers)) {
    return {state: 'APPROVED', title: 'Approved', detail: `${plural(changedTestIds.length, 'change')} accepted in Eyes.`}
  }
  if (designers.allowed.size === 0) {
    return {
      state: 'WAITING',
      title: "Designers couldn't be determined",
      detail: `Nobody can approve until this is fixed: ${designers.problem ?? 'no designers resolved'}.`
    }
  }

  const approvedBy = new Set<string>()
  const notByDesigner = new Set<string>()
  for (const testId of changedTestIds) {
    const who = [...(approvers.get(testId) ?? [])]
    const byDesigner = who.filter(u => allows(designers, u))
    if (byDesigner.length === 0) {
      who.forEach(u => notByDesigner.add(u))
    } else {
      byDesigner.forEach(u => approvedBy.add(u))
    }
  }
  if (approvedBy.size === 0 || notByDesigner.size > 0) {
    const others = [...notByDesigner].sort()
    return {
      state: 'WAITING',
      title: 'Waiting for a designer',
      detail:
        `Changes were accepted${others.length === 0 ? '' : ` by ${others.join(', ')}`}` +
        `, but a designer (${describe(designers)}) must approve them.` +
        (designers.problem ? ` Note: ${designers.problem}.` : '')
    }
  }
  return {
    state: 'APPROVED',
    title: `Approved by ${[...approvedBy].sort().join(', ')}`,
    detail: 'Every visual change was accepted by a designer.'
  }
}

/** Compares refreshes: post only when this changes (SPEC §8.2). */
export function designState(verdict: Verdict): string {
  return `${verdict.state}: ${verdict.title}`
}

function plural(n: number, noun: string): string {
  return `${n} ${noun}${n === 1 ? '' : 's'}`
}
