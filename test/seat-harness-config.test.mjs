import assert from 'node:assert/strict'
import test from 'node:test'
import { SeatRuntime } from '../src/seat-runtime.mjs'

const registration = { command: '/synthetic/node', args: ['/synthetic/native.js'] }

test('共有設定とhook登録は子の完了まで直列化し、次の開始時の台帳を渡す', async () => {
  const started = Promise.withResolvers(), finish = Promise.withResolvers()
  const requests = []
  const runtime = new SeatRuntime({ root: '/synthetic', home: '/synthetic/home',
    run: async (_command, _args, { input }) => {
      const request = JSON.parse(input)
      requests.push(request)
      if (request.action === 'configure-harnesses') { started.resolve(); await finish.promise }
      return { stdout: '{"result":null}' }
    },
  })
  const bots = new Map([['old', { id: 'old', project: '/synthetic/old' }]])
  const first = runtime.configureHarnesses(bots, registration, { enabled: false })
  await started.promise
  const second = runtime.writeHarnessConfig(bots, registration, { enabled: true })
  await Promise.resolve()
  assert.deepEqual(requests.map(request => request.action), ['configure-harnesses'])
  await runtime.projectFiles.ensureRoot('/synthetic/projects')
  assert.equal(requests.at(-1).action, 'project')
  bots.delete('old')
  bots.set('new', { id: 'new', project: '/synthetic/new', privateField: 'omit' })
  finish.resolve()
  await Promise.all([first, second])
  assert.deepEqual(requests.at(-1).profiles, [{ id: 'new', project: '/synthetic/new' }])
  assert.deepEqual(requests.at(-1).aiterm, registration)
  assert.deepEqual(requests.at(-1).callBridge, { enabled: true })
})

test('先行する共有設定更新の失敗を呼出元へ返し、後続更新を妨げない', async () => {
  const started = Promise.withResolvers(), finish = Promise.withResolvers()
  const actions = []
  const runtime = new SeatRuntime({ root: '/synthetic', home: '/synthetic/home',
    run: async (_command, _args, { input }) => {
      const { action } = JSON.parse(input)
      actions.push(action)
      if (actions.length === 1) {
        started.resolve()
        await finish.promise
        return { stdout: JSON.stringify({ error: { name: 'SyntaxError', message: 'synthetic invalid JSON', code: 'SYNTHETIC_CONFIG' } }) }
      }
      return { stdout: '{"result":null}' }
    },
  })
  const first = runtime.writeHarnessConfig(new Map(), registration, { enabled: false })
  const failed = assert.rejects(first, { name: 'SyntaxError', message: 'synthetic invalid JSON', code: 'SYNTHETIC_CONFIG' })
  await started.promise
  const second = runtime.configureHarnesses(new Map(), registration, { enabled: false })
  finish.resolve()
  await failed
  assert.equal(await second, null)
  assert.deepEqual(actions, ['write-harness-config', 'configure-harnesses'])
})

test('the seat child report lines reach the body log; stdout stays the JSON answer', async t => {
  const written = []
  t.mock.method(process.stderr, 'write', chunk => { written.push(String(chunk)); return true })
  const runtime = new SeatRuntime({ root: '/synthetic', home: '/synthetic/home',
    run: async () => ({ stdout: '{"result":7}', stderr: 'BellTeam MCP xarticle: report\n' }) })
  assert.equal(await runtime.call('configure-harnesses', {}), 7)
  t.mock.restoreAll()
  assert.deepEqual(written, ['BellTeam MCP xarticle: report\n'])
})
