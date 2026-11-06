import {afterEach, beforeEach, describe, expect, it} from 'vitest'
import {DoctorConfig, doctorMarkdown, runDoctor} from '../src/doctor.js'
import {EyesClient} from '../src/eyes.js'
import {FakeEyes} from './fake-eyes.js'

let eyes: FakeEyes

beforeEach(async () => {
  eyes = await new FakeEyes().start()
  eyes.keys.set('RUN', {read: false})
  eyes.keys.set('READ', {read: true, orgId: 'org1'})
  eyes.keys.set('MERGE', {read: true, merge: true, permissions: ['merge']})
  eyes.keys.set('WRITE', {read: false, permissions: ['write']})
  eyes.teams = [{id: 't1', name: 'Design', members: {'dana@example.com': {}}}]
})

afterEach(() => eyes.stop())

function doctor(config: Partial<DoctorConfig>, readPullRequests?: () => Promise<void>) {
  return runDoctor(
    {serverUrl: eyes.url, allowHttp: false, apiKey: 'RUN', readApiKey: 'READ', mergeApiKey: 'MERGE', designers: [], ...config},
    {eyes: key => new EyesClient(eyes.url, key), readPullRequests}
  )
}

const summary = (items: {name: string; status: string}[]) => items.map(i => `${i.status} ${i.name}`)

describe('runDoctor (SPEC §13)', () => {
  it('passes a complete setup, without changing anything in Eyes', async () => {
    const items = await doctor({designers: ['team:Design']}, async () => {})
    expect(summary(items)).toEqual(['ok Eyes server', 'ok Run key', 'ok Read key', 'ok Merge key', 'ok Designers', 'ok GitHub'])
    expect(items.find(i => i.name === 'Designers')!.detail).toBe('dana@example.com (Eyes teams resolved with the read key).')
    expect(eyes.merges).toEqual([])
  })

  it('says what to fix for each wrong key', async () => {
    const items = await doctor({apiKey: 'WRITE', readApiKey: undefined, mergeApiKey: undefined})
    expect(summary(items)).toEqual(['ok Eyes server', 'fail Run key', 'fail Read key', 'warn Merge key', 'ok Designers'])
    expect(items[1].detail).toContain('write permission, so Eyes refuses its test uploads')
    expect(items[2].detail).toContain("It can't read results (no `readApiKey`, so this is the run key)")
    expect(items[3].detail).toContain('APPLITOOLS_MERGE_KEY')
  })

  it('fails a merge key Eyes refuses', async () => {
    const items = await doctor({mergeApiKey: 'READ'})
    expect(items.find(i => i.name === 'Merge key')).toMatchObject({status: 'fail'})
  })

  it('reports an unknown key and missing designers', async () => {
    const items = await doctor({apiKey: 'NOPE', designers: ['team:Nobody']})
    expect(items.find(i => i.name === 'Run key')!.detail).toContain("Eyes doesn't accept it (HTTP 401)")
    expect(items.find(i => i.name === 'Designers')).toMatchObject({status: 'fail', detail: "Nobody can approve: Eyes team 'Nobody' not found. Check the team names in Eyes."})
  })

  it('counts designers instead of naming them with hideReviewers', async () => {
    const items = await doctor({designers: ['team:Design'], hideReviewers: true})
    expect(items.find(i => i.name === 'Designers')!.detail).toBe('1 designer (Eyes teams resolved with the read key).')
  })

  it('stops at a server URL the keys mustn\'t go to', async () => {
    const items = await doctor({serverUrl: 'http://eyes.example.com'})
    expect(summary(items)).toEqual(['fail Eyes server'])
    expect(eyes.requests).toEqual([])
  })

  it('reports a token that can\'t read pull requests', async () => {
    const items = await doctor({}, async () => Promise.reject(new Error('HTTP 403')))
    expect(items.at(-1)).toMatchObject({name: 'GitHub', status: 'fail'})
    expect(doctorMarkdown(items)).toContain('| ❌ GitHub |')
  })
})
