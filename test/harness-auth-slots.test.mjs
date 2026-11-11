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
  // Aiterm >= 0.70.20 echoes the token-login mode on every 2nd result.
  const echo = (args, result) => args.login && result?.structuredContent ? { ...result, structuredContent: { ...result.structuredContent, login: args.login } } : result
  return { calls, client: { async call(name, args) { calls.push({ name, args }); return echo(args, await call(args)) } } }
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

test('relogin keeps the existing account label and paste-code prompt while another slot remains blocked', async () => {
  let complete = false
  const { calls, client } = clientWith(args => {
    const second = args.configuration_root.endsWith('/2nd')
    return { structuredContent: receipt(second ? 'second-session' : 'first-session',
      complete && !second ? { status: 'authenticated', account_label: 'new@example.invalid' } : { account_label: null }) }
  })
  const auth = new HarnessAuth({ bots: new Map(), client, accounts: {
    async prepare(_harness, slot) { return { configurationRoot: `/synthetic/${slot}` } },
    async list() { return { harnesses: [{ harness: 'claude', slots: [
      { slot: '1st', loggedIn: true, label: 'existing@example.invalid' },
      { slot: '2nd', loggedIn: false, label: null },
    ] }] } },
  } })

  for (const result of [await auth.start('claude'), await auth.status('claude', { slot: '1st' }),
    await auth.input('claude', inputFor('first-session'))]) {
    assert.equal(result.auth.status, 'waiting')
    assert.equal(result.account_label, 'existing@example.invalid')
    assert.deepEqual(result.auth.auth_ui.binding, makeBinding('first-session'))
    assert.equal(result.auth.auth_ui.stage, 'paste_code')
    assert.equal(result.auth.auth_ui.prompt_digest, 'a'.repeat(64))
    assert.equal(result.auth.input_required, true)
    assert.equal(Object.hasOwn(result, 'loggedIn'), false)
  }
  const second = await auth.start('claude', { slot: '2nd' })
  assert.equal(second.auth.status, 'blocked')
  assert.equal(second.account_label, null)
  assert.equal((await auth.status('claude')).auth.status, 'waiting')
  complete = true
  const finished = await auth.input('claude', inputFor('first-session'))
  assert.equal(finished.auth.status, 'authenticated')
  assert.equal(finished.account_label, 'new@example.invalid')
  assert.equal(auth.sessions.has('claude'), false)
  assert.equal(auth.receipts.has('claude'), false)
  assert.equal(auth.sessions.get('claude:2nd'), 'second-session')
  assert.equal(calls.filter(({ args }) => args.action === 'cancel').length, 1)
})

test('pre-start authenticated status supports relogin when account metadata is unavailable and cancellation clears evidence', async () => {
  let running = false
  const { client } = clientWith(args => {
    if (args.action === 'start') running = true
    if (args.action === 'cancel') running = false
    return { structuredContent: running ? receipt('first-session', { account_label: null })
      : { schema: 'aiterm.agent-auth-result.v1', status: 'authenticated', account_label: 'old@example.invalid' } }
  })
  const auth = new HarnessAuth({ bots: new Map(), client, accounts: {
    async list() { throw Object.assign(new Error('older metadata port'), { code: 'EXECUTION_REQUEST_INVALID' }) },
  } })
  assert.equal((await auth.status('claude')).auth.status, 'authenticated')
  assert.equal((await auth.start('claude')).account_label, 'old@example.invalid')
  assert.equal((await auth.status('claude')).auth.status, 'waiting')
  assert.equal((await auth.start('claude')).auth.status, 'waiting')
  await auth.cancel('claude')
  assert.equal(auth.sessions.size, 0)
  assert.equal(auth.receipts.size, 0)
  const restored = await auth.status('claude')
  assert.equal(restored.auth.status, 'authenticated')
  assert.equal(restored.account_label, 'old@example.invalid')
})

test('relogin becomes blocked when stored credentials are removed and never carries evidence across a logged-out status', async () => {
  let loggedIn = true
  const { client } = clientWith(() => ({ structuredContent: receipt('first-session', { account_label: null }) }))
  const auth = new HarnessAuth({ bots: new Map(), client, accounts: {
    async prepare() { return { configurationRoot: '/synthetic/first' } },
    async list() { return { harnesses: [{ harness: 'claude', slots: [{ slot: '1st', loggedIn, label: loggedIn ? 'old@example.invalid' : null }] }] } },
  } })
  assert.equal((await auth.start('claude')).auth.status, 'waiting')
  loggedIn = false
  const current = await auth.status('claude')
  assert.equal(current.auth.status, 'blocked')
  assert.equal(current.account_label, null)
  await auth.cancel('claude')
  assert.equal((await auth.start('claude')).auth.status, 'blocked')

  let status = 'authenticated'
  const legacy = new HarnessAuth({ bots: new Map(), client: { async call() {
    return { structuredContent: { schema: 'aiterm.agent-auth-result.v1', status, session_id: status === 'blocked' ? null : undefined } }
  } } })
  await legacy.status('claude')
  status = 'blocked'
  await legacy.status('claude')
  assert.equal(legacy.receipts.get('claude').loggedIn, false)
})

test('2nd login writes oauth-token through Aiterm: every 2nd action carries login + token_file, 1st carries none', async () => {
  const { calls, client } = clientWith(args => ({ structuredContent: receipt(args.configuration_root.endsWith('/2nd') ? 'second-session' : 'first-session') }))
  const auth = new HarnessAuth({ bots: new Map(), client,
    accounts: { async prepare(_harness, slot) { return { configurationRoot: `/synthetic/${slot}` } } } })
  await auth.start('claude')
  await auth.start('claude', { slot: '2nd' })
  await auth.status('claude', { slot: '2nd' })
  await auth.input('claude', inputFor('second-session'), { slot: '2nd' })
  await auth.cancel('claude', { slot: '2nd' })
  const second = calls.filter(({ args }) => args.configuration_root === '/synthetic/2nd')
  assert.deepEqual(second.map(({ args }) => args.action), ['start', 'status', 'respond', 'cancel'])
  assert.ok(second.every(({ args }) => args.login === 'oauth_token' && args.token_file === '/synthetic/2nd/oauth-token'))
  assert.ok(calls.filter(({ args }) => args.configuration_root === '/synthetic/1st').every(({ args }) => !('login' in args) && !('token_file' in args)))
})

test('2nd refuses an Aiterm without the oauth_token echo and a failed 2nd cancel cannot block the next start', async () => {
  let echo = false, cancelFails = false
  const calls = []
  const client = { async call(_name, args) {
    calls.push(args)
    if (args.action === 'cancel' && cancelFails) throw Object.assign(new Error('rejected'), { code: 'AGENT_AUTH_LOGIN_REJECTED' })
    return { structuredContent: receipt('second-session', echo ? { login: 'oauth_token' } : { status: 'authenticated', session_id: null }) }
  } }
  const auth = new HarnessAuth({ bots: new Map(), client,
    accounts: { async prepare(_harness, slot) { return { configurationRoot: `/synthetic/${slot}` } } } })
  await assert.rejects(auth.start('claude', { slot: '2nd' }), { code: 'HARNESS_AUTH_LOGIN_UNSUPPORTED', status: 409 })
  await assert.rejects(auth.status('claude', { slot: '2nd' }), { code: 'HARNESS_AUTH_LOGIN_UNSUPPORTED' })
  echo = true
  assert.equal((await auth.start('claude', { slot: '2nd' })).auth.session_id, 'second-session')
  cancelFails = true
  const restarted = await auth.start('claude', { slot: '2nd' })
  assert.equal(restarted.auth.session_id, 'second-session')
  assert.deepEqual(calls.slice(-2).map(args => args.action), ['cancel', 'start'])
})
