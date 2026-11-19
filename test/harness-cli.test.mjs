import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import test from 'node:test'
import { BotRegistry } from '../src/bot-registry.mjs'
import { HarnessAuth } from '../src/harness-auth.mjs'
import { HarnessCli, cliNotice } from '../src/harness-cli.mjs'
import { Onboarding } from '../src/onboarding.mjs'
import { Subscriptions } from '../src/subscriptions.mjs'
import { usageEffectResultValid, usageEffectValid } from '../src/usage/channel-protocol.mjs'
import { createUsageFacade } from '../src/usage/facade.mjs'
import { respondHttpError } from '../src/http-errors.mjs'
import { createUsageApi } from '../src/usage/http-api.mjs'
import { createUsageProjection } from '../src/usage/projection.mjs'
import { usageResultValid } from '../src/usage/process-results.mjs'
import { validateUsageRequest } from '../src/usage/process-schema.mjs'

const owner = { kind: 'owner', botId: null }
const gone = { installed: false, version: null, source: null }
const image = { installed: true, version: '1.4.2', source: 'image' }

// A fake box: facts per harness; install flips one to the user place after a gate opens.
function box(initial = {}) {
  const facts = { claude: image, codex: gone, grok: gone, cursor: gone, ...initial }
  const gates = [], installs = []
  return { facts, installs, gates,
    probe: async id => facts[id],
    install: id => new Promise((resolve, reject) => {
      installs.push(id)
      gates.push(error => { if (error) return reject(Object.assign(new Error(error), { code: error })); facts[id] = { installed: true, version: '2.0.0', source: 'user' }; resolve({ version: '2.0.0' }) })
    }) }
}
const settle = () => new Promise(resolve => setImmediate(resolve))

test('states: a bundled CLI reads installed; an absent one is not_installed; the same press is the update', async () => {
  const b = box(), seen = []
  const cli = new HarnessCli({ probe: b.probe, install: b.install, onChange: value => seen.push(value) })
  assert.equal(cli.get('claude').state, 'checking')
  await cli.probeAll()
  assert.deepEqual(cli.get('claude'), { harness: 'claude', state: 'installed', version: '1.4.2', source: 'image', busy: false })
  assert.equal(cli.get('codex').state, 'not_installed')
  assert.match(cli.view('claude').message, /BellTeamに最初から入っている物です/u)
  assert.equal(cli.view('claude').action, 'install'); assert.equal(cli.view('claude').label, '最新版を入れる')
  assert.equal(cli.absent('claude'), false); assert.equal(cli.absent('codex'), true)
  assert.equal(cli.notice('codex'), 'Codexがまだ入っていません。AIの認証から入れてください')
  assert.equal(cli.notice('claude'), null)
  // the update of a working CLI: it stays installed while busy, and a failed press only sets lastError
  const press = cli.install('claude'); await settle()
  assert.equal(cli.get('claude').state, 'installed'); assert.equal(cli.get('claude').busy, true)
  assert.equal(cli.view('claude').action, null); assert.match(cli.view('claude').message, /今の版はそのまま使えます/u)
  assert.equal(cli.install('claude'), press, 'a second press on a running one is the same work')
  b.gates[0]('CLI_INSTALL_NETWORK'); await press
  assert.equal(cli.get('claude').state, 'installed')
  assert.deepEqual(cli.view('claude').lastError, { code: 'CLI_INSTALL_NETWORK', message: '通信できませんでした。' })
  assert.match(cli.view('claude').message, /前回、最新版を入れられませんでした。通信できませんでした。/u)
  assert.ok(seen.length > 0)
})

test('install of an absent CLI: installing -> installed (user); a failed press with no CLI is failed and exits by pressing again', async () => {
  const b = box(), events = []
  const cli = new HarnessCli({ probe: b.probe, install: b.install })
  await cli.probeAll()
  cli.watch(value => events.push([value.harness, value.state, value.busy]))
  const first = cli.install('codex'); await settle()
  assert.equal(cli.get('codex').state, 'installing'); assert.equal(cli.notice('codex'), 'Codexを入れています。終わるまでお待ちください')
  assert.equal(cli.view('codex').message, '入れています。数分かかることがあります。')
  b.gates[0]('CLI_INSTALL_TIMEOUT'); await first
  assert.equal(cli.get('codex').state, 'failed')
  assert.match(cli.view('codex').message, /入れられませんでした。時間内に終わりませんでした。もう一度「最新版を入れる」を押してください。/u)
  assert.equal(cli.notice('codex'), 'Codexを入れられませんでした。AIの認証からもう一度入れてください')
  const again = cli.install('codex'); await settle(); b.gates[1](); await again
  assert.deepEqual(cli.get('codex'), { harness: 'codex', state: 'installed', version: '2.0.0', source: 'user', busy: false })
  assert.deepEqual(events.filter(([id]) => id === 'codex').map(([, state]) => state), ['installing', 'failed', 'installing', 'installed'])
})

test('presses run one at a time', async () => {
  const b = box()
  const cli = new HarnessCli({ probe: b.probe, install: b.install })
  await cli.probeAll()
  const a = cli.install('codex'), c = cli.install('grok'); await settle()
  assert.deepEqual(b.installs, ['codex'])
  assert.equal(cli.get('grok').state, 'installing')
  b.gates[0](); await a; await settle()
  assert.deepEqual(b.installs, ['codex', 'grok'])
  b.gates[1](); await c
  assert.equal(cli.get('grok').state, 'installed')
})

test('a body that cannot probe or install leaves the feature absent: no install object, nothing refused', async () => {
  const unsupported = () => Promise.reject(Object.assign(new Error('USAGE_IPC_INVALID'), { code: 'USAGE_IPC_INVALID' }))
  const cli = new HarnessCli({ probe: unsupported, install: unsupported })
  await cli.probeAll()
  assert.equal(cli.supported, false); assert.equal(cli.view('claude'), null); assert.equal(cli.absent('claude'), false)
  const stubbed = new HarnessCli({ probe: async () => undefined, install: async () => undefined })
  await stubbed.probeAll()
  assert.equal(stubbed.view('claude'), null)
  // a body that probes but cannot install: the press fails with the plain reason, the working CLI stays installed
  const b = box()
  const partial = new HarnessCli({ probe: b.probe, install: unsupported })
  await partial.probeAll()
  await partial.install('claude')
  assert.equal(partial.get('claude').state, 'installed')
  assert.equal(partial.view('claude').lastError.code, 'CLI_INSTALL_UNSUPPORTED')
})

test('HarnessAuth: the list carries install, and start/status refuse an absent AI with the plain sentence (409)', async () => {
  const b = box(), calls = []
  const cli = new HarnessCli({ probe: b.probe, install: b.install })
  await cli.probeAll()
  const auth = new HarnessAuth({ bots: new Map(), cli, client: { authOptions: () => ({}), async call(name, args) {
    calls.push(args.action)
    return { structuredContent: { schema: 'aiterm.agent-auth-result.v1', harness: args.harness, status: 'authenticated', session_id: null, url: null, user_code: null, input_required: false, message: null } }
  } } })
  const list = auth.list().harnesses
  assert.equal(list.find(item => item.id === 'claude').install.state, 'installed')
  assert.equal(list.find(item => item.id === 'codex').install.message, 'まだ入っていません。「最新版を入れる」で入れてください。')
  for (const run of [() => auth.status('codex'), () => auth.start('codex')])
    await assert.rejects(run(), { code: 'HARNESS_NOT_INSTALLED', status: 409, message: 'Codexがまだ入っていません。AIの認証から入れてください' })
  assert.deepEqual(calls, [])
  assert.equal((await auth.status('claude')).auth.status, 'authenticated')
  assert.equal(new HarnessAuth({ bots: new Map(), client: {} }).list().harnesses.some(item => 'install' in item), false)
})

test('Onboarding: choose an absent AI -> blocked sentence, install, then the login starts by itself', async t => {
  const root = await mkdtemp(join(tmpdir(), 'bellteam-cli-onboarding-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const seedPath = join(root, 'bots.json'); await writeFile(seedPath, JSON.stringify({ schema: 'bellteam.bots.v1', bots: [] }))
  const bots = new BotRegistry({ seedPath, botsRoot: join(root, 'bots') }); await bots.initialize()
  const subscriptions = new Subscriptions({ path: join(root, 'shared/subscription.json') }); await subscriptions.initialize()
  const b = box(), calls = []
  const cli = new HarnessCli({ probe: b.probe, install: b.install }); await cli.probeAll()
  const onboarding = new Onboarding({ root, bots, subscriptions, cli, startConversation: async () => {},
    client: { async call(name, args) {
      calls.push(args.action)
      return { structuredContent: { schema: 'aiterm.agent-auth-result.v1', harness: args.harness, status: 'waiting', session_id: 'auth-session', url: 'https://example.com/login', user_code: 'TEST-CODE', input_required: false, message: null } }
    } } })
  await onboarding.initialize()
  assert.equal(onboarding.snapshot().harnesses.find(item => item.id === 'claude').install.state, 'installed')
  const selected = await onboarding.select('codex')
  assert.equal(selected.phase, 'authenticate'); assert.equal(selected.install.state, 'not_installed')
  assert.equal(selected.auth.status, 'blocked'); assert.equal(selected.auth.message, 'Codexがまだ入っていません。AIの認証から入れてください')
  assert.equal(selected.auth.session_id, null); assert.deepEqual(calls, [])
  await assert.rejects(new Onboarding({ root, bots, subscriptions, cli, client: {}, startConversation: async () => {} }).install(), { code: 'SETUP_HARNESS_REQUIRED' })
  const press = onboarding.install(); await settle()
  assert.equal(onboarding.snapshot().install.state, 'installing')
  assert.equal((await onboarding.status()).auth.status, 'blocked', 'status polls answer while the install runs')
  b.gates[0](); const done = await press
  assert.equal(done.install.state, 'installed'); assert.equal(done.auth.user_code, 'TEST-CODE'); assert.equal(done.auth.session_id, 'auth-session')
  assert.deepEqual(calls, ['start'])
})

test('contract: effect and result validators, owner-only methods, result shapes', () => {
  const root = (method, mode = null, kind = 'root') => ({ generation: 'g', rootId: '1', kind, method, mode, actor: owner, continuation: false })
  const params = { harness: 'codex' }
  assert.equal(usageEffectValid('cli.install', params, root('harnessCli.install'), params), true)
  assert.equal(usageEffectValid('cli.install', params, root('harnessCli.install'), { harness: 'grok' }), false, 'the effect must be for the pressed AI')
  assert.equal(usageEffectValid('cli.install', params, root('harnessCli.recheck'), params), false)
  assert.equal(usageEffectValid('cli.probe', params, root('harnessCli.recheck'), params), true)
  assert.equal(usageEffectValid('cli.probe', params, root('onboarding.install')), true)
  assert.equal(usageEffectValid('cli.probe', params, root('initialize', 'services', 'control')), true)
  assert.equal(usageEffectValid('cli.probe', params, root('auth.start'), params), false)
  assert.equal(usageEffectValid('cli.probe', { harness: 'copilot' }, root('harnessCli.recheck'), { harness: 'copilot' }), false)
  assert.equal(usageEffectValid('cli.install', { harness: 'codex', url: 'https://x' }, root('harnessCli.install'), params), false, 'the child names only a harness')
  assert.equal(usageEffectResultValid('cli.probe', image), true)
  assert.equal(usageEffectResultValid('cli.probe', { ...image, path: '/x' }), false)
  assert.equal(usageEffectResultValid('cli.install', { version: '2.0.0' }), true)
  assert.equal(usageEffectResultValid('cli.install', { version: '2.0.0', output: 'x' }), false)
  assert.doesNotThrow(() => validateUsageRequest('harnessCli.install', params, owner))
  assert.throws(() => validateUsageRequest('harnessCli.install', params, { kind: 'bot', botId: 'bot-a' }), { code: 'USAGE_ACTOR_FORBIDDEN' })
  assert.throws(() => validateUsageRequest('harnessCli.install', { harness: 'copilot' }, owner), { code: 'USAGE_INPUT_INVALID' })
  assert.doesNotThrow(() => validateUsageRequest('harnessCli.recheck', params, { kind: 'system', botId: null }))
  assert.throws(() => validateUsageRequest('onboarding.install', {}, { kind: 'bot', botId: 'bot-a' }), { code: 'USAGE_ACTOR_FORBIDDEN' })
  const cli = new HarnessCli({ probe: async () => gone, install: async () => ({ version: '1' }) })
  assert.equal(usageResultValid('harnessCli.install', cli.view('claude'), params), true)
  assert.equal(usageResultValid('harnessCli.install', { state: 'checking' }, params), false, 'a view missing its fields is refused')
  assert.equal(usageResultValid('harnessCli.recheck', { harness: 'codex', state: 'installed', version: '2.0.0', source: 'user', busy: false }, params), true)
  assert.equal(usageResultValid('harnessCli.recheck', { harness: 'grok', state: 'installed', version: '2.0.0', source: 'user', busy: false }, params), false)
  assert.equal(cliNotice('claude', 'installed'), null)
})

async function http(api, path, method = 'POST') {
  const request = Readable.from([Buffer.from('{}')]); request.method = method; request.headers = { 'content-type': 'application/json' }
  let result
  await api(request, { writeHead(status) { result = { status } }, end(body) { result.body = JSON.parse(body) } }, new URL(path, 'https://box.example.invalid'))
  return result
}

test('HTTP: install routes are owner-only, answer once the press has started, and the window reads the pushed copy', async () => {
  const b = box(), calls = []
  const cli = new HarnessCli({ probe: b.probe, install: b.install }); await cli.probeAll()
  const auth = new HarnessAuth({ bots: new Map(), cli, client: {} })
  // the parent copy: what the child pushes as the auth row
  const projection = createUsageProjection({ bots: new Map() })
  const copy = () => ({ harnesses: auth.list().harnesses })
  const facade = createUsageFacade({ projection: { auth: copy }, request: async (method, params) => {
    calls.push([method, params])
    const pending = cli.install(params.harness)
    return pending
  } })
  const api = createUsageApi({ harnessAuth: facade.harnessAuth, captureUsageContext: (_request, method) => ({ method }) })
  const read = await http(api, '/api/harness-auth/codex/install', 'GET')
  assert.equal(read.status, 200); assert.equal(read.body.install.state, 'not_installed')
  const pressed = await http(api, '/api/harness-auth/codex/install')
  assert.equal(pressed.status, 200); assert.equal(pressed.body.install.state, 'installing'); assert.equal(pressed.body.install.action, null)
  assert.deepEqual(calls, [['harnessCli.install', { harness: 'codex' }]])
  assert.equal((await http(api, '/api/harness-auth/codex/install', 'GET')).body.install.busy, true)
  assert.equal(facade.harnessCli.get('codex').state, 'installing')
  b.gates[0](); await settle()
  assert.equal((await http(api, '/api/harness-auth/codex/install', 'GET')).body.install.state, 'installed')
  const internal = createUsageApi({ internal: true, harnessAuth: facade.harnessAuth })
  assert.equal((await http(internal, '/api/harness-auth/codex/install')).status, 403)
  await assert.rejects(http(api, '/api/harness-auth/nope/install', 'GET'), { code: 'HARNESS_AUTH_HARNESS_INVALID' })
  assert.equal(projection.auth === undefined, false)
})

test('HTTP: a login for an absent AI answers 409 with the plain sentence, though the module IPC carries only the code', async () => {
  const cli = new HarnessCli({ probe: box().probe, install: box().install }); await cli.probeAll()
  const auth = new HarnessAuth({ bots: new Map(), cli, client: {} })
  const ipcError = () => Object.assign(new Error('HARNESS_NOT_INSTALLED'), { code: 'HARNESS_NOT_INSTALLED', status: 409, outcome: 'not_accepted' })
  const facade = createUsageFacade({ projection: { auth: () => ({ harnesses: auth.list().harnesses }) }, request: async () => { throw ipcError() } })
  const api = createUsageApi({ harnessAuth: facade.harnessAuth, captureUsageContext: (_request, method) => ({ method }) })
  for (const [path, method] of [['/api/harness-auth/codex', 'GET'], ['/api/harness-auth/codex/start', 'POST']]) {
    const error = await http(api, path, method).then(() => null, e => e)
    const reply = {}
    await respondHttpError({ method, url: path }, { writeHead(status) { reply.status = status }, end(body) { reply.body = JSON.parse(body) } }, error)
    assert.deepEqual(reply, { status: 409, body: { error: 'HARNESS_NOT_INSTALLED', message: 'Codexがまだ入っていません。AIの認証から入れてください' } })
  }
})

test('HTTP: POST /api/setup/install answers with the snapshot once the press has started, owner only', async () => {
  const snapshot = { phase: 'authenticate', harness: 'codex', harnesses: [], guideBotId: 'bot-guide', complete: false, auth: null, install: { state: 'installing', busy: true } }
  const calls = []
  let release
  const onboarding = { snapshot: () => snapshot, status: async () => snapshot,
    install: context => { calls.push(context); return new Promise(resolve => { release = resolve }) } }
  const api = createUsageApi({ onboarding, notify() {}, captureUsageContext: (_request, method) => ({ method }) })
  const started = await http(api, '/api/setup/install')
  assert.equal(started.status, 200); assert.equal(started.body.install.state, 'installing')
  assert.deepEqual(calls, [{ method: 'onboarding.install' }])
  release(snapshot)
  const refused = createUsageApi({ onboarding, internal: true, notify() {} })
  assert.equal((await http(refused, '/api/setup/install')).status, 403)
  const failing = createUsageApi({ onboarding: { ...onboarding, install: async () => { throw Object.assign(new Error('SETUP_HARNESS_REQUIRED'), { code: 'SETUP_HARNESS_REQUIRED', status: 409 }) } }, notify() {} })
  await assert.rejects(http(failing, '/api/setup/install'), { code: 'SETUP_HARNESS_REQUIRED' })
})
