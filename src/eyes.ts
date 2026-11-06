/**
 * Minimal Eyes REST client (SPEC §10). Sends the key in the `X-Eyes-Api-Key` header, keeping it out of URLs. Node's
 * fetch asks for gzip and decompresses on its own (Eyes JSON shrinks ~6x).
 */
import {BatchResults, parseResults} from './results.js'
import {Team} from './designers.js'

const TIMEOUT_MS = 30_000
const API_KEY_HEADER = 'X-Eyes-Api-Key'

export class EyesHttpError extends Error {
  constructor(
    readonly status: number,
    message: string
  ) {
    super(message)
    this.name = 'EyesHttpError'
  }

  /** Eyes rejected the key for this operation (e.g. a run key reading results). */
  get unauthorized(): boolean {
    return this.status === 401 || this.status === 403
  }
}

export interface KeyInfo {
  teamId?: string
  orgId?: string
  user?: string
  permissions: string[]
}

export interface MergeResult {
  merged: boolean
  conflicts: number
  /** Baseline changes merged. */
  changes: number
}

export class EyesClient {
  private readonly serverUrl: string

  constructor(
    serverUrl: string,
    private readonly apiKey: string
  ) {
    this.serverUrl = serverUrl.replace(/\/+$/, '')
  }

  /**
   * Closes a batch by the pointer ID the SDKs were given (SPEC §10.2), which triggers Eyes' notifications and SCM
   * integration.
   *
   * @returns false if Eyes has no batch with this ID, usually because no tests ran
   */
  async closeBatch(batchId: string): Promise<boolean> {
    const path = `/api/sessions/batches/${enc(batchId)}/close/bypointerid`
    let response = await this.send('DELETE', path)
    if (response.status === 401) {
      // Older or on-prem servers may only accept the key as a query parameter on this endpoint.
      response = await this.send('DELETE', `${path}?apiKey=${enc(this.apiKey)}`, false)
    }
    if (response.status === 404) return false
    await requireSuccess(response, `closing batch ${batchId}`)
    return true
  }

  /** How many tests in the batch are still rendering or comparing; 0 when results are final (SPEC §10.4). */
  async runningCount(batchId: string): Promise<number> {
    const response = await this.send('GET', `/api/sessions/batches/${enc(batchId)}/bypointerid`)
    if (response.status === 404) return 0
    await requireSuccess(response, `reading batch ${batchId}`)
    const json = await this.json(response)
    return Number(json?.runningCount) || 0
  }

  /** Results by pointer ID (SPEC §10.3); undefined if Eyes has no such batch. Needs a read key. */
  async getResults(batchId: string): Promise<BatchResults | undefined> {
    const response = await this.send('GET', `/api/v1/batches/${enc(batchId)}`)
    if (response.status === 404) return undefined
    await requireSuccess(response, `reading results for batch ${batchId}`)
    return parseResults(batchId, await this.json(response))
  }

  /** `GET /api/v1/auth/api-key-validation` (SPEC §10.6). */
  async keyInfo(): Promise<KeyInfo> {
    const response = await this.send('GET', '/api/v1/auth/api-key-validation')
    await requireSuccess(response, 'validating the API key')
    const json = await this.json(response)
    return {
      teamId: optString(json?.teamId),
      orgId: optString(json?.orgId),
      user: optString(json?.user),
      permissions: Array.isArray(json?.permissions) ? json.permissions.map(String) : []
    }
  }

  /** The organization's teams ("accounts" in the admin API) and their members' login emails. Read key is enough. */
  async teams(orgId: string): Promise<Team[]> {
    const response = await this.send('GET', `/api/admin/orgs/${enc(orgId)}/accounts/?format=json`)
    await requireSuccess(response, 'listing Eyes teams')
    const json = await this.json(response)
    if (!Array.isArray(json)) throw new Error('Eyes returned an unexpected team list')
    return json
      .filter(t => t && typeof t === 'object')
      .map(t => ({
        id: optString(t.id),
        name: optString(t.name) ?? '',
        members: t.members && typeof t.members === 'object' ? Object.keys(t.members).sort() : []
      }))
  }

  /** Teams of the key's own organization. */
  async ownTeams(): Promise<Team[]> {
    const info = await this.keyInfo()
    if (!info.orgId) throw new Error("Eyes didn't report an organization for this key, so its teams can't be listed")
    return this.teams(info.orgId)
  }

  /**
   * Who accepted this session's changes (SPEC §6.4): users whose accept came from this very session. Reviews are
   * recorded in `appOutputResolution[].lastAccept` once a session is resolved; `expectedAppOutput` is the baseline as it
   * was when the test ran, so it only names earlier sessions (and the sessionId match filters them out).
   */
  async sessionApprovers(eyesBatchId: string, sessionId: string): Promise<Set<string>> {
    const response = await this.send('GET', `/api/sessions/batches/${enc(eyesBatchId)}/${enc(sessionId)}`)
    await requireSuccess(response, `reading session ${sessionId}`)
    const session = await this.json(response)
    const users = new Set<string>()
    for (const field of ['appOutputResolution', 'expectedAppOutput']) {
      const outputs = session?.[field]
      if (!Array.isArray(outputs)) continue
      for (const output of outputs) {
        const accept = output?.lastAccept
        if (accept && accept.sessionId === sessionId && accept.user) users.add(String(accept.user))
      }
    }
    return users
  }

  /**
   * Starts merging one baseline branch into another, both `owner/repo/branch` (SPEC §10.7). Needs a merge key.
   *
   * @returns the task ID to poll
   */
  async startBranchMerge(source: string, target: string): Promise<string> {
    const query = `SourceBranch=${enc(source)}&TargetBranch=${enc(target)}&OnlyCheck=false`
    const response = await this.send('POST', `/api/baselines/branches/merge?${query}`)
    if (response.status === 404) {
      await response.body?.cancel()
      throw new EyesHttpError(404, `Eyes has no baseline branch '${source}' or '${target}'`)
    }
    if (response.status !== 202) await requireSuccess(response, `starting a merge of ${source} into ${target}`)
    await response.body?.cancel()
    const location = response.headers.get('Location') ?? ''
    const id = /\/tasks\/([^/?]+)/.exec(location)?.[1]
    if (!id) throw new Error('Eyes accepted the merge but returned no task ID')
    // Eyes sends the ID already URL-encoded ("…%7e1r"); decode it so it isn't encoded twice.
    return decodeURIComponent(id)
  }

  /** True once the merge task has finished (HTTP 201), false while it runs (HTTP 200). */
  async isTaskDone(taskId: string): Promise<boolean> {
    const response = await this.send('GET', `/api/tasks/${enc(taskId)}/status`)
    await response.body?.cancel()
    if (response.status === 201) return true
    if (response.status === 200) return false
    await requireSuccess(response, `checking merge task ${taskId}`)
    return false
  }

  async taskResult(taskId: string): Promise<MergeResult> {
    const response = await this.send('GET', `/api/tasks/${enc(taskId)}/result`)
    if (response.status === 404) {
      await response.body?.cancel()
      throw new EyesHttpError(404, "Eyes couldn't find one of the branches to merge")
    }
    await requireSuccess(response, `reading merge task ${taskId}`)
    const json = await this.json(response)
    return {
      merged: json?.merged === true,
      conflicts: Number(json?.conflicts) || 0,
      changes: Array.isArray(json?.changes) ? json.changes.length : 0
    }
  }

  private async send(method: string, pathAndQuery: string, withKey = true): Promise<Response> {
    const headers: Record<string, string> = {Accept: 'application/json'}
    if (withKey) headers[API_KEY_HEADER] = this.apiKey
    try {
      return await fetch(this.serverUrl + pathAndQuery, {method, headers, signal: AbortSignal.timeout(TIMEOUT_MS)})
    } catch (e) {
      // Never let a URL carrying the key (the close fallback) reach a log.
      throw new Error(`couldn't reach Eyes at ${this.serverUrl}: ${causeMessage(e)}`)
    }
  }

  private async json(response: Response): Promise<any> {
    const text = await response.text()
    try {
      return JSON.parse(text)
    } catch {
      throw new Error(`Eyes returned an unexpected response (HTTP ${response.status})`)
    }
  }
}

async function requireSuccess(response: Response, what: string): Promise<void> {
  if (response.ok) return
  await response.body?.cancel()
  throw new EyesHttpError(response.status, `Eyes returned HTTP ${response.status} ${what}`)
}

function enc(value: string): string {
  return encodeURIComponent(value)
}

function optString(value: unknown): string | undefined {
  return value === undefined || value === null ? undefined : String(value)
}

function causeMessage(e: unknown): string {
  if (e instanceof Error) {
    const cause = (e as Error & {cause?: unknown}).cause
    return cause instanceof Error ? `${e.message} (${cause.message})` : e.message
  }
  return String(e)
}
