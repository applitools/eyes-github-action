/**
 * Per-run state the follow-up workflows need (SPEC §8.1), stored in the Visual tests check run itself because an Action
 * has no registry on disk. It rides at the end of the check summary as an HTML comment, which GitHub doesn't render.
 */

export interface GateState {
  v: 1
  /** Pointer ID the SDKs were given. */
  batchId: string
  /** Eyes branch the tests ran on (`owner/repo/branch`), which the baseline merge merges from (SPEC §11). */
  branchName?: string
  /** Eyes' own batch ID, for session lookups. */
  eyesBatchId?: string
  /** Tests that had visual changes when the run finished. */
  changed: string[]
  /** Expectations, re-applied on every refresh (SPEC §5.2). */
  expectTests?: number
  expectApps?: string[]
  /** `designReview` option or env, when one decided (label events are then ignored). */
  designForced?: boolean
}

const MARKER = 'applitools-gate-state'
const PATTERN = new RegExp(`<!-- ${MARKER} (\\{.*?\\}) -->`)

export function encodeState(state: GateState): string {
  // "--" can't appear inside an HTML comment; JSON escapes keep the payload readable back.
  return `\n<!-- ${MARKER} ${JSON.stringify(state).replace(/--/g, '-\\u002d')} -->\n`
}

export function decodeState(summary: string | null | undefined): GateState | undefined {
  const match = summary ? PATTERN.exec(summary) : null
  if (!match) return undefined
  try {
    const state = JSON.parse(match[1])
    return state?.v === 1 && typeof state.batchId === 'string' ? state : undefined
  } catch {
    return undefined
  }
}
