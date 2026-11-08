import assert from 'node:assert/strict'
import test from 'node:test'
import { HarnessAuth } from '../src/harness-auth.mjs'

const makeBinding = session_id => ({ session_id, launch_id: null, metadata_identity: `dev:ino:${session_id}`,
  native_id: `native-${session_id}`, pane_id: `%${session_id}`, server_pid: 100, server_started: '100-start',
  pane_pid: 101, pane_started: '101-start' })
const receipt = (session, value = {}) => ({ schema: 'aiterm.agent-auth-result.v1', status: 'blocked', session_id: session,
  input_required: true, auth_ui: { schema: 'aiterm.auth-ui.v1', binding: makeBinding(session), stage: 'paste_code',
    title: 'Official login', message: 'Enter the displayed code.', url: 'https://claude.com/login', user_code: null,
    input: 'authorization_code', prompt_digest: 'a'.repeat(64), choices: [] }, ...value })
const inputFor = session => ({ binding: makeBinding(session), prompt_digest: 'a'.repeat(64),
  response: { kind: 'authorization_code', value: 'synthetic-code' } })

function clientWith(call) {
  const calls = []
  return { calls, client: { async call(name, args) { calls.push({ name, args }); return call(args) } } }
}

test('no slot remains 1st; Claude receipts carry slot and native label without exposing configuration root', async () => {
  const { calls, client } = clientWith(args => ({ structuredContent: receipt('first-session', { account_label: 'first@example.invalid' }) }))
  const auth = new HarnessAuth({ bots: new Map(), client,
    accounts: { async prepare(harness, slot) { assert.equal(harness, 'claude'); assert.equal(slot, '1st'); return { configurationRoot: '/synthetic/first' } } } })

  const result = await auth.start('claude')

  assert.equal(result.harness, 'claude')
  assert.equal(result.slot, '1st')
  assert.equal(result.account_label, 'first@example.invalid')
  assert.equal(result.auth.session_id, 'first-session')
  assert.equal(JSON.stringify(result).includes('/synthetic/first'), false)
  assert.equal(calls[0].args.configuration_root, '/synthetic/first')
})

test('1st and 2nd sessions stay separate through start, input, and cancelling only 1st', async () => {
  const roots = { '1st': '/synthetic/first', '2nd': '/synthetic/second' }
  const { calls, client } = clientWith(args => {
    const slot = args.configuration_root === roots['2nd'] ? '2nd' : '1st'
    const session = slot === '2nd' ? 'second-session' : 'first-session'
    return { structuredContent: receipt(session, { account_label: `${slot}@example.invalid` }) }
  })
  const auth = new HarnessAuth({ bots: new Map(), client,
    accounts: { async prepare(harness, slot) { assert.equal(harness, 'claude'); return { configurationRoot: roots[slot] } } } })

  const first = await auth.start('claude')
  const second = await auth.start('claude', { slot: '2nd' })
  await auth.cancel('claude')
  await auth.input('claude', inputFor('second-session'), { slot: '2nd' })

  assert.equal(first.slot, '1st')
  assert.equal(second.slot, '2nd')
  assert.equal(second.account_label, '2nd@example.invalid')
  assert.deepEqual(calls.filter(({ args }) => args.action === 'cancel').map(({ args }) => args.session_id), ['first-session'])
  const respond = calls.find(({ args }) => args.action === 'respond')
  assert.equal(respond.args.session_id, 'second-session')
  assert.equal(respond.args.configuration_root, roots['2nd'])
  assert.ok(calls.filter(({ args }) => args.configuration_root).every(({ args }) => roots[args.configuration_root === roots['2nd'] ? '2nd' : '1st'] === args.configuration_root))
})

test('wrong-slot bound input is rejected without native respond and the correct slot still works', async () => {
  const sessions = { '1st': 'first-session', '2nd': 'second-session' }
  const { calls, client } = clientWith(args => ({ structuredContent: receipt(
    args.configuration_root.endsWith('/2nd') ? sessions['2nd'] : sessions['1st']) }))
  const auth = new HarnessAuth({ bots: new Map(), client,
    accounts: { async prepare(_harness, slot) { return { configurationRoot: `/synthetic/${slot}` } } } })
  await auth.start('claude')
  await auth.start('claude', { slot: '2nd' })

  await assert.rejects(auth.input('claude', inputFor('first-session'), { slot: '2nd' }), { code: 'AUTH_RESPONSE_INVALID' })
  assert.equal(calls.some(({ args }) => args.action === 'respond'), false)
  await auth.input('claude', inputFor('first-session'))
  assert.equal(calls.filter(({ args }) => args.action === 'respond').length, 1)
  assert.equal(calls.find(({ args }) => args.action === 'respond').args.session_id, 'first-session')
})

test('missing accounts, invalid slots, and invalid native labels fail before unsafe calls and do not poison the queue', async () => {
  let label = null
  const native = clientWith(args => {
    const session = args.configuration_root?.endsWith('/second') ? 'second-session' : 'first-session'
    return { structuredContent: receipt(session, { account_label: label }) }
  })
  const noAccounts = new HarnessAuth({ bots: new Map(), client: native.client })
  const legacy = await noAccounts.start('claude')
  assert.equal(legacy.slot, '1st')
  assert.equal(native.calls[0].args.configuration_root, undefined)
  await assert.rejects(noAccounts.start('claude', { slot: '2nd' }), { code: 'HARNESS_AUTH_ACCOUNTS_UNAVAILABLE' })
  assert.equal(native.calls.length, 1)

  const auth = new HarnessAuth({ bots: new Map(), client: native.client,
    accounts: { async prepare(_harness, slot) { return { configurationRoot: `/synthetic/${slot}` } } } })
  await assert.rejects(auth.start('claude', { slot: 'other' }), { code: 'HARNESS_AUTH_SLOT_INVALID' })
  await assert.rejects(auth.start('codex', { slot: '2nd' }), { code: 'HARNESS_AUTH_SLOT_INVALID' })
  label = 42
  await assert.rejects(auth.start('claude'), { code: 'HARNESS_AUTH_RESPONSE_INVALID' })
  label = 'claude@example.invalid'
  assert.equal((await auth.status('claude')).account_label, 'claude@example.invalid')
  assert.equal((await auth.cancel('claude', { slot: '2nd' })).slot, '2nd')
})

test('preparation failures normalize for both slots and a later successful preparation still runs', async () => {
  const expected = 'アカウントの保存場所を用意できませんでした。少し待ってから、もう一度お試しください。'
  for (const slot of ['1st', '2nd']) {
    for (const failure of [
      Object.assign(new Error('path /private/root'), { code: 'EACCES', errno: -13 }),
      Object.assign(new Error('path /private/root'), { code: 'ACCOUNT_ROOT_UNAVAILABLE' }),
      new Error('path /private/root'),
    ]) {
      let fail = true
      const { calls, client } = clientWith(args => ({ structuredContent: receipt('recovered-session') }))
      const auth = new HarnessAuth({ bots: new Map(), client,
        accounts: { async prepare() { if (fail) throw failure; return { configurationRoot: `/synthetic/${slot}` } } } })

      await assert.rejects(auth.start('claude', { slot }), error => {
        assert.equal(error.code, 'HARNESS_AUTH_ACCOUNTS_UNAVAILABLE')
        assert.equal(error.status, 503)
        assert.equal(error.message, expected)
        assert.equal(error.message.includes('/private/root'), false)
        assert.equal(error.message.includes('EACCES'), false)
        return true
      })
      assert.equal(calls.length, 0)
      fail = false
      assert.equal((await auth.start('claude', { slot })).auth.session_id, 'recovered-session')
      assert.equal(calls.length, 1)
      assert.equal(calls[0].args.configuration_root, `/synthetic/${slot}`)
    }
  }
})

test('EXECUTION_REQUEST_INVALID keeps 1st default-root compatibility and rejects 2nd without native auth', async () => {
  const { calls, client } = clientWith(() => ({ structuredContent: receipt('default-session') }))
  const accounts = { async prepare() { throw Object.assign(new Error('/private/root'), { code: 'EXECUTION_REQUEST_INVALID' }) } }
  const auth = new HarnessAuth({ bots: new Map(), client, accounts })

  assert.equal((await auth.status('claude')).auth.session_id, null)
  assert.equal(calls.length, 1)
  assert.equal(calls[0].args.action, 'status')
  assert.equal(calls[0].args.configuration_root, undefined)
  await assert.rejects(auth.status('claude', { slot: '2nd' }), error => {
    assert.equal(error.code, 'HARNESS_AUTH_ACCOUNTS_UNAVAILABLE')
    assert.equal(error.status, 503)
    assert.equal(error.message, 'アカウントの保存場所を用意できませんでした。少し待ってから、もう一度お試しください。')
    return true
  })
  assert.equal(calls.length, 1)
})

test('invalid prepared roots including null remain rejected for both slots', async () => {
  const { calls, client } = clientWith(() => ({ structuredContent: receipt('unexpected-session') }))
  const auth = new HarnessAuth({ bots: new Map(), client,
    accounts: { async prepare(_harness, slot) { return slot === '1st' ? null : { configurationRoot: 'relative/root' } } } })

  for (const slot of ['1st', '2nd']) {
    await assert.rejects(auth.status('claude', { slot }), error => {
      assert.equal(error.code, 'HARNESS_AUTH_ACCOUNTS_UNAVAILABLE')
      assert.equal(error.status, 503)
      assert.equal(error.message, 'アカウントの保存場所を用意できませんでした。少し待ってから、もう一度お試しください。')
      return true
    })
  }
  assert.equal(calls.length, 0)
})
