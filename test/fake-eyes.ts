/** A fake Eyes server mirroring the response shapes in SPEC §10, gzip included. */
import {createServer, type IncomingMessage, type Server, type ServerResponse} from 'node:http'
import type {AddressInfo} from 'node:net'
import {gzipSync} from 'node:zlib'

export interface FakeTest {
  testId: string
  testName: string
  appName?: string
  status: string
  /** Who accepted it in Eyes (appOutputResolution.lastAccept). */
  acceptedBy?: string
}

export interface FakeBatch {
  eyesBatchId: string
  name: string
  tests: FakeTest[]
  /** runningCount values to return in turn; the last one repeats. */
  running?: number[]
  closed?: boolean
}

export interface Request {
  method: string
  path: string
  apiKey?: string
  acceptEncoding?: string
}

export class FakeEyes {
  readonly batches = new Map<string, FakeBatch>()
  readonly requests: Request[] = []
  /** Keys and what they may do. */
  readonly keys = new Map<string, {read: boolean; orgId?: string}>()
  teams: {id: string; name: string; members: Record<string, object>}[] = []
  /** Only accept the key as a query parameter on close (older servers). */
  closeNeedsQueryKey = false
  private server?: Server

  get url(): string {
    const {port} = this.server!.address() as AddressInfo
    return `http://127.0.0.1:${port}`
  }

  async start(): Promise<this> {
    this.server = createServer((req, res) => this.handle(req, res))
    await new Promise<void>(r => this.server!.listen(0, '127.0.0.1', r))
    return this
  }

  async stop(): Promise<void> {
    await new Promise<void>(r => this.server?.close(() => r()))
  }

  private handle(req: IncomingMessage, res: ServerResponse): void {
    const url = new URL(req.url ?? '/', 'http://x')
    const apiKey = (req.headers['x-eyes-api-key'] as string | undefined) ?? url.searchParams.get('apiKey') ?? undefined
    this.requests.push({
      method: req.method ?? '',
      path: url.pathname + url.search,
      apiKey,
      acceptEncoding: req.headers['accept-encoding'] as string | undefined
    })
    const key = apiKey ? this.keys.get(apiKey) : undefined
    const send = (status: number, body?: unknown): void => {
      if (body === undefined) {
        res.writeHead(status).end()
        return
      }
      const json = Buffer.from(JSON.stringify(body))
      const gzip = String(req.headers['accept-encoding'] ?? '').includes('gzip')
      res.writeHead(status, {'Content-Type': 'application/json', ...(gzip ? {'Content-Encoding': 'gzip'} : {})})
      res.end(gzip ? gzipSync(json) : json)
    }
    if (!key) return send(401, {message: 'Unauthorized'})

    const parts = url.pathname.split('/').filter(Boolean).map(decodeURIComponent)
    // DELETE /api/sessions/batches/{pointer}/close/bypointerid
    if (req.method === 'DELETE' && parts[4] === 'close') {
      if (this.closeNeedsQueryKey && req.headers['x-eyes-api-key']) return send(401, {})
      const batch = this.batches.get(parts[3])
      if (!batch) return send(404)
      batch.closed = true
      return send(200)
    }
    // GET /api/sessions/batches/{pointer}/bypointerid
    if (req.method === 'GET' && parts[0] === 'api' && parts[1] === 'sessions' && parts[4] === 'bypointerid') {
      if (!key.read) return send(403, {})
      const batch = this.batches.get(parts[3])
      if (!batch) return send(404)
      const running = batch.running && batch.running.length > 1 ? batch.running.shift()! : (batch.running?.[0] ?? 0)
      return send(200, {id: batch.eyesBatchId, runningCount: running, isReviewed: false})
    }
    // GET /api/v1/batches/{pointer}
    if (req.method === 'GET' && parts[1] === 'v1' && parts[2] === 'batches') {
      if (req.headers['x-eyes-api-key'] === undefined) return send(401, {})
      if (!key.read) return send(403, {})
      const batch = this.batches.get(parts[3])
      if (!batch) return send(404)
      return send(200, this.results(parts[3], batch))
    }
    // GET /api/v1/auth/api-key-validation
    if (url.pathname === '/api/v1/auth/api-key-validation') {
      return send(200, {teamId: 't1', orgId: key.orgId, user: 'ci@example.com', permissions: ['read']})
    }
    // GET /api/admin/orgs/{orgId}/accounts/
    if (parts[1] === 'admin' && parts[4] === 'accounts') {
      if (!key.read || parts[3] !== key.orgId) return send(403, {})
      return send(200, this.teams)
    }
    // GET /api/sessions/batches/{eyesBatchId}/{sessionId}
    if (req.method === 'GET' && parts[1] === 'sessions' && parts.length === 5) {
      if (!key.read) return send(403, {})
      const batch = [...this.batches.values()].find(b => b.eyesBatchId === parts[3])
      const test = batch?.tests.find(t => t.testId === parts[4])
      if (!test) return send(404)
      return send(200, {
        id: test.testId,
        // The baseline at run time names an earlier session: must be ignored.
        expectedAppOutput: [{lastAccept: {user: 'old@example.com', sessionId: 'earlier-session', time: 't0'}}],
        appOutputResolution: test.acceptedBy
          ? [{lastAccept: {user: test.acceptedBy, sessionId: test.testId, time: 't1'}, isManuallyRejected: false}]
          : []
      })
    }
    send(404)
  }

  private results(pointer: string, batch: FakeBatch): unknown {
    const count = (status: string): number => batch.tests.filter(t => t.status === status).length
    return {
      statistics: {
        id: batch.eyesBatchId,
        pointerId: pointer,
        name: batch.name,
        passed: count('passed'),
        failed: count('failed'),
        unresolved: count('unresolved'),
        new: count('new'),
        aborted: 0,
        empty: 0,
        total: batch.tests.length
      },
      batchUrl: `${this.url}/app/test-results/${batch.eyesBatchId}`,
      tests: batch.tests.map(t => ({
        testId: t.testId,
        testName: t.testName,
        appName: t.appName ?? 'App',
        status: t.status,
        branchName: 'owner/repo/feature',
        runBy: 'ci',
        env: {app: 'Chrome 155.0', os: 'Linux', device: 'Desktop', viewport: {width: 1280, height: 800}},
        sessionUrl: `${this.url}/app/test-results/${batch.eyesBatchId}/${t.testId}`,
        steps: []
      }))
    }
  }
}
