import assert from 'node:assert/strict'
import { EventEmitter, once } from 'node:events'
import { Readable } from 'node:stream'
import test from 'node:test'
import { createBellTeamServer } from '../src/http-server.mjs'
import { createControlApi } from '../src/http-application-api.mjs'

const versionId = 'a'.repeat(64)
const path = '/api/notifications-release'

test('通知版の公開入口は既認証・内部拒否・入力制限を保ち同controllerへ渡す', async t => {
  let starts = 0, reserves = 0, refreshes = 0
  let authenticated = true, active = false
  const bots = Object.assign(new Map(), { async refresh() { refreshes++ } })
  const state = { currentVersionId: null, available: false, status: null, update: null }
  const controller = {
    snapshot: () => structuredClone(state),
    reserve(id) {
      reserves++
      if (active) throw Object.assign(new Error('NOTIFICATIONS_UPDATE_IN_PROGRESS'), { code: 'NOTIFICATIONS_UPDATE_IN_PROGRESS', status: 409 })
      assert.ok([versionId, 'builtin'].includes(id))
      active = true
      state.update = { versionId: id, status: 'accepted' }
      return { start() { starts++; state.update.status = 'running' }, cancel() {} }
    },
  }
  const server = createBellTeamServer({ bots, store: {}, transport: {}, notificationsReleaseControl: controller,
    authorize: async () => authenticated, writeLog() {},
  })
  server.listen(0, '127.0.0.1'); await once(server, 'listening')
  t.after(() => new Promise(resolve => server.close(resolve)))
  const base = `http://127.0.0.1:${server.address().port}`
  const post = body => fetch(base + path, { method: 'POST', body: JSON.stringify(body) })
  authenticated = false
  assert.equal((await post({ versionId })).status, 401)
  assert.equal(reserves, 0)
  authenticated = true
  for (const body of [null, [], {}, { versionId: 'A'.repeat(64) }, { versionId, path: '/untrusted' }]) {
    assert.equal((await post(body)).status, 400)
  }
  assert.equal((await fetch(base + path, { method: 'PATCH' })).status, 405)
  assert.equal((await post({ versionId: 'a'.repeat(1025) })).status, 400)
  const before = await (await fetch(base + path)).json()
  assert.deepEqual(before.notificationsRelease, state)
  const accepted = await post({ versionId })
  assert.equal(accepted.status, 202)
  assert.equal((await accepted.json()).notificationsRelease.update.status, 'accepted')
  assert.equal(starts, 1)
  assert.equal((await post({ versionId })).status, 409)
  assert.equal((await (await fetch(base + path)).json()).notificationsRelease.update.status, 'running')
  active = false
  assert.equal((await post({ versionId: 'builtin' })).status, 202)
  assert.equal(state.update.versionId, 'builtin')
  assert.equal(refreshes, 0)
  const api = createControlApi({ internal: true, notificationsReleaseControl: controller })
  const response = { writeHead(status) { this.status = status }, end(body) { this.body = JSON.parse(body) } }
  await api({ method: 'POST' }, response, new URL('http://local' + path))
  assert.equal(response.status, 403)
  assert.equal(reserves, 3)
  const unavailable = createControlApi({})
  await unavailable({ method: 'GET' }, response, new URL('http://local' + path))
  assert.equal(response.status, 503)
})

test('202のfinish前断線は予約を取消し、応答終了前に交換を始めない', async () => {
  for (const finished of [false, true]) {
    let starts = 0, cancels = 0
    const response = Object.assign(new EventEmitter(), {
      writableFinished: false,
      writeHead(status) { assert.equal(status, 202) },
      end() {},
    })
    const api = createControlApi({ notificationsReleaseControl: {
      snapshot: () => ({ update: { status: 'accepted' } }),
      reserve: () => ({ start() { starts++ }, cancel() { cancels++ } }),
    } })
    await api(Object.assign(Readable.from([Buffer.from(JSON.stringify({ versionId }))]), { method: 'POST' }), response, new URL('http://local' + path))
    assert.equal(starts, 0)
    if (finished) { response.writableFinished = true; response.emit('finish') }
    response.emit('close')
    assert.equal(starts, Number(finished))
    assert.equal(cancels, Number(!finished))
  }
})
