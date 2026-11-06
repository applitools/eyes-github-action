import {afterEach, beforeEach, describe, expect, it} from 'vitest'
import {EyesClient, EyesHttpError} from '../src/eyes.js'
import {FakeEyes} from './fake-eyes.js'

let eyes: FakeEyes

beforeEach(async () => {
  eyes = await new FakeEyes().start()
  eyes.keys.set('RUN', {read: false})
  eyes.keys.set('READ', {read: true, orgId: 'org1'})
  eyes.batches.set('sha1', {
    eyesBatchId: 'eyes-1',
    name: 'acme/web PR #7: x',
    running: [2, 1, 0],
    tests: [
      {testId: 's1', testName: 'Button', status: 'unresolved', acceptedBy: 'dana@example.com'},
      {testId: 's2', testName: 'Card', appName: 'Storybook', status: 'passed'}
    ]
  })
})

afterEach(() => eyes.stop())

describe('EyesClient against a fake Eyes server', () => {
  it('sends the key in a header and asks for gzip (decompressed transparently)', async () => {
    const results = await new EyesClient(`${eyes.url}/`, 'READ').getResults('sha1')
    expect(results?.total).toBe(2)
    const request = eyes.requests.at(-1)!
    expect(request.path).toBe('/api/v1/batches/sha1')
    expect(request.apiKey).toBe('READ')
    expect(request.acceptEncoding).toContain('gzip')
  })

  it('closes batches; 404 means no tests reported (SPEC §10.2)', async () => {
    const client = new EyesClient(eyes.url, 'RUN')
    expect(await client.closeBatch('sha1')).toBe(true)
    expect(eyes.batches.get('sha1')!.closed).toBe(true)
    expect(await client.closeBatch('unknown')).toBe(false)
    expect(eyes.requests.at(-1)).toMatchObject({method: 'DELETE', path: '/api/sessions/batches/unknown/close/bypointerid'})
  })

  it('retries close with the key as a query parameter only when allowed (URLs get logged)', async () => {
    eyes.closeNeedsQueryKey = true
    await expect(new EyesClient(eyes.url, 'RUN').closeBatch('sha1')).rejects.toThrow('Eyes returned HTTP 401 closing batch sha1')
    expect(eyes.requests.some(r => r.path.includes('apiKey='))).toBe(false)
    expect(await new EyesClient(eyes.url, 'RUN', true).closeBatch('sha1')).toBe(true)
    expect(eyes.requests.at(-1)!.path).toBe('/api/sessions/batches/sha1/close/bypointerid?apiKey=RUN')
  })

  it("doesn't echo a response that isn't JSON", async () => {
    eyes.raw.set('/api/v1/batches/sha1', {status: 200, contentType: 'text/html', body: '<h1>internal secret</h1>'})
    await expect(new EyesClient(eyes.url, 'READ').getResults('sha1')).rejects.toThrow(
      /^Eyes returned an unexpected response \(HTTP 200, text\/html\)$/
    )
  })

  it('refuses a response over 16 MB, compressed or not', async () => {
    const big = Buffer.alloc(17 * 1024 * 1024, 32)
    eyes.raw.set('/api/v1/batches/sha1', {status: 200, contentType: 'application/json', body: big, gzip: true})
    await expect(new EyesClient(eyes.url, 'READ').getResults('sha1')).rejects.toThrow('Eyes sent more than 16 MB')
  })

  it('reads runningCount until rendering is done (SPEC §10.4)', async () => {
    const client = new EyesClient(eyes.url, 'READ')
    expect([await client.runningCount('sha1'), await client.runningCount('sha1'), await client.runningCount('sha1')]).toEqual([
      2, 1, 0
    ])
    expect(await client.runningCount('missing')).toBe(0)
  })

  it('parses results (SPEC §10.3)', async () => {
    const r = (await new EyesClient(eyes.url, 'READ').getResults('sha1'))!
    expect(r).toMatchObject({batchId: 'sha1', eyesBatchId: 'eyes-1', unresolved: 1, passed: 1, total: 2})
    expect(r.url).toBe(`${eyes.url}/app/test-results/eyes-1`)
    expect(r.tests[0]).toMatchObject({id: 's1', status: 'unresolved', environment: 'Chrome 155.0 on Linux 1280×800'})
    expect(await new EyesClient(eyes.url, 'READ').getResults('missing')).toBeUndefined()
  })

  it('raises an unauthorized error when a run key reads results (SPEC §10.1)', async () => {
    const error = await new EyesClient(eyes.url, 'RUN').getResults('sha1').catch(e => e)
    expect(error).toBeInstanceOf(EyesHttpError)
    expect(error.status).toBe(403)
    expect(error.unauthorized).toBe(true)
  })

  it('lists the key organization teams with member emails (SPEC §10.6)', async () => {
    eyes.teams = [
      {id: 'abc', name: "Tim's Eyes Org", members: {'tim@example.com': {name: 'Tim', isAdmin: true, isViewer: false}}},
      {id: 'def', name: 'Design', members: {}}
    ]
    const client = new EyesClient(eyes.url, 'READ')
    expect(await client.keyInfo()).toMatchObject({orgId: 'org1', permissions: ['read']})
    expect(await client.ownTeams()).toEqual([
      {id: 'abc', name: "Tim's Eyes Org", members: ['tim@example.com']},
      {id: 'def', name: 'Design', members: []}
    ])
    expect(eyes.requests.at(-1)!.path).toBe('/api/admin/orgs/org1/accounts/?format=json')
  })

  it('reads approvers from appOutputResolution, not expectedAppOutput (SPEC §6.4)', async () => {
    const client = new EyesClient(eyes.url, 'READ')
    expect([...(await client.sessionApprovers('eyes-1', 's1'))]).toEqual(['dana@example.com'])
    expect([...(await client.sessionApprovers('eyes-1', 's2'))]).toEqual([])
  })

  it('reports unreachable servers without leaking the key', async () => {
    const error = await new EyesClient('http://127.0.0.1:1', 'SECRET').closeBatch('x').catch(e => e)
    expect(error.message).toMatch(/couldn't reach Eyes/)
    expect(error.message).not.toContain('SECRET')
  })
})
