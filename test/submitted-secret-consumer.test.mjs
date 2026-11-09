import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import test from 'node:test'
import { SecretRequests } from '../src/secret-requests.mjs'
import { createSubmittedSecretConsumer } from '../src/usage/submitted-secret-consumer.mjs'
import { createSubmittedSecretRabbitClient } from '../src/usage/submitted-secret-rabbit-client.mjs'
import { createUsageApi } from '../src/usage/http-api.mjs'
import { Readable } from 'node:stream'

const challenge = { binding: { session_id: 'original-session', launch_id: null, metadata_identity: 'original-metadata', native_id: 'native', pane_id: 'pane',
  server_pid: 10, server_started: '1', pane_pid: 11, pane_started: '2' }, prompt_digest: 'a'.repeat(64) }
const inputReceipt = { schema: 'bellteam.submitted-secret-input.v1', outcome: 'issued', authStatus: 'authenticated', httpStatus: 200 }

async function fixture(t, sourceInput) {
  const root = await mkdtemp(join(tmpdir(), 'submitted-secret-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const service = new SecretRequests({ root, bots: new Map([['bot-centi', {}]]), rooms: new Map(), notify: async () => {},
    onePassword: { available: true, refresh: async () => {}, watch: () => () => {}, close() {}, resolve: async () => '  synthetic-code\n' } })
  t.after(() => service.close())
  await service.initialize()
  const item = await service.create({ botId: 'bot-centi', toolId: 'claude-code', label: 'Synthetic code', message: 'Synthetic fixture' })
  await service.submit(item.id, sourceInput ?? '  synthetic-code\n')
  const context = { requestId: item.id, requesterBotId: 'bot-centi', toolId: 'claude-code', roomId: null }
  const runDirectory = join(root, 'state/submitted-secret-consumption')
  const admission = Object.freeze({})
  let metadataReads = 0, calls = 0
  const secretRequests = { toolsDirectory: service.toolsDirectory, read: async id => { metadataReads++; return service.get(id) } }
  const options = { secretRequests, runDirectory, context,
    assertAuthorized: async (token, current) => { assert.equal(token, admission); assert.deepEqual(current, challenge) },
    consume: async (payload, { assertBeforeIssue }) => { assertBeforeIssue(); calls++; assert.deepEqual(payload, { ...challenge, response: { kind: 'authorization_code', value: 'synthetic-code' } }); return inputReceipt } }
  return { root, service, context, options, admission, runDirectory, input: { requestId: item.id, challenge, admission }, counts: () => ({ metadataReads, calls }) }
}

test('C5 submitted reference resolution retains one-shot claim and requester checks without a value path', async t => {
  const reference = `op://${'a'.repeat(26)}/${'b'.repeat(26)}/credential`
  const f = await fixture(t, { source: 'onepassword', reference })
  f.options.secretRequests.resolveValue = id => f.service.resolveValue(id)
  assert.equal(f.service.get(f.context.requestId).path, undefined)
  const receipt = await createSubmittedSecretConsumer(f.options).execute(f.input)
  assert.equal(receipt.outcome, 'issued'); assert.equal(f.counts().calls, 1)
  assert.equal((await createSubmittedSecretConsumer(f.options).execute(f.input)).reason, 'already_claimed')
  const wrong = { ...f.options.secretRequests, read: async id => ({ ...f.service.get(id), botId: 'another' }) }
  assert.equal((await createSubmittedSecretConsumer({ ...f.options, secretRequests: wrong }).execute(f.input)).reason, 'wrong_request')
  const saved = await readFile(join(f.runDirectory, f.context.requestId + '.claim'), 'utf8')
  assert.ok(!saved.includes(reference)); assert.ok(!saved.includes('synthetic-code'))
})

test('submitted: durable claim precedes consume; concurrent and restarted callers issue once without leaking', async t => {
  const f = await fixture(t)
  const consume = f.options.consume
  f.options.consume = async (...args) => {
    const saved = await readFile(join(f.runDirectory, f.context.requestId + '.claim'), 'utf8')
    assert.equal(JSON.parse(saved).reason, 'claimed')
    assert.equal((await stat(join(f.runDirectory, f.context.requestId + '.claim'))).mode & 0o777, 0o600)
    return consume(...args)
  }
  const first = createSubmittedSecretConsumer(f.options), second = createSubmittedSecretConsumer(f.options)
  const receipts = await Promise.all([first.execute(f.input), second.execute(f.input)])
  assert.equal(receipts.filter(r => r.outcome === 'issued').length, 1)
  assert.equal(f.counts().calls, 1)
  const restarted = await createSubmittedSecretConsumer(f.options).execute(f.input)
  assert.equal(restarted.reason, 'already_claimed')
  assert.equal(f.counts().calls, 1)
  const saved = await readFile(join(f.runDirectory, f.context.requestId + '.claim'), 'utf8')
  assert.ok(!JSON.stringify([receipts, saved]).includes('synthetic-code'))
  assert.ok(!saved.includes(challenge.prompt_digest))
  assert.ok(!saved.includes(challenge.binding.session_id))
})

test('submitted: forged admission and invalid challenge stop before metadata, claim and consume', async t => {
  const f = await fixture(t)
  const denied = await createSubmittedSecretConsumer(f.options).execute({ ...f.input, admission: {} })
  assert.equal(denied.reason, 'not_authorized')
  const invalid = await createSubmittedSecretConsumer(f.options).execute({ ...f.input, challenge: { ...challenge, value: 'forbidden' } })
  assert.equal(invalid.reason, 'invalid_challenge')
  assert.equal((await createSubmittedSecretConsumer(f.options).execute({ ...f.input, challenge: { ...challenge, prompt_digest: [challenge.prompt_digest] } })).reason, 'invalid_challenge')
  assert.deepEqual(f.counts(), { metadataReads: 0, calls: 0 })
  await assert.rejects(stat(f.runDirectory), { code: 'ENOENT' })
})

test('submitted: owner, tool, state, room and arbitrary path mismatches stop before claim', async t => {
  const f = await fixture(t)
  for (const patch of [{ botId: 'bot-other' }, { toolId: 'other' }, { status: 'pending' }, { roomId: 'room-other' }, { path: join(f.root, 'other') }]) {
    const secretRequests = { ...f.options.secretRequests, read: async id => ({ ...f.service.get(id), ...patch }) }
    assert.equal((await createSubmittedSecretConsumer({ ...f.options, secretRequests }).execute(f.input)).reason, 'wrong_request')
  }
  assert.equal(f.counts().calls, 0)
  await assert.rejects(stat(f.runDirectory), { code: 'ENOENT' })
})

test('submitted: authorization revoked after durable claim leaves claim and sends nothing', async t => {
  const f = await fixture(t)
  let checks = 0
  const consumer = createSubmittedSecretConsumer({ ...f.options, assertAuthorized: async () => { if (++checks === 3) throw new Error('sensitive error text') } })
  const receipt = await consumer.execute(f.input)
  assert.equal(receipt.outcome, 'unknown')
  assert.equal(f.counts().calls, 0)
  assert.ok(!JSON.stringify(receipt).includes('sensitive'))
  assert.equal((await createSubmittedSecretConsumer(f.options).execute(f.input)).reason, 'already_claimed')
})

test('submitted: symlink secret, broad permissions and invalid code leave claim and send nothing', async t => {
  for (const kind of ['symlink', 'mode', 'code']) {
    const f = await fixture(t), path = f.service.get(f.context.requestId).path
    await rm(path)
    if (kind === 'symlink') { const target = join(f.root, 'target'); await writeFile(target, 'synthetic-code', { mode: 0o600 }); await symlink(target, path) }
    else await writeFile(path, kind === 'code' ? 'invalid\ncode' : 'synthetic-code', { mode: kind === 'mode' ? 0o644 : 0o600 })
    assert.equal((await createSubmittedSecretConsumer(f.options).execute(f.input)).reason, 'secret_unavailable')
    assert.equal(f.counts().calls, 0)
    assert.equal((await createSubmittedSecretConsumer(f.options).execute(f.input)).reason, 'already_claimed')
  }
})

test('submitted: storage denial stops before secret consumption', async t => {
  const f = await fixture(t)
  const file = join(f.root, 'not-directory'); await writeFile(file, 'fixture')
  const receipt = await createSubmittedSecretConsumer({ ...f.options, runDirectory: file }).execute(f.input)
  assert.equal(receipt.reason, 'storage_unavailable')
  assert.equal(f.counts().calls, 0)
})

test('submitted: thrown transport and malformed receipt are unknown and cannot be retried', async t => {
  for (const consume of [async () => { throw new Error('synthetic-code') }, async () => ({ ...inputReceipt, value: 'synthetic-code' }), async () => ({ ...inputReceipt, authStatus: null })]) {
    const f = await fixture(t)
    const receipt = await createSubmittedSecretConsumer({ ...f.options, consume }).execute(f.input)
    assert.equal(receipt.outcome, 'unknown')
    assert.ok(!JSON.stringify(receipt).includes('synthetic-code'))
    assert.equal((await createSubmittedSecretConsumer(f.options).execute(f.input)).reason, 'already_claimed')
  }
})

test('submitted: close cancels and waits for the real consume terminal even after another execute', async t => {
  const f = await fixture(t)
  let entered, release, terminal = false
  const inConsume = new Promise(resolve => { entered = resolve })
  const consume = async (_, { signal }) => { entered(); await new Promise(resolve => { release = resolve }); terminal = true; assert.equal(signal.aborted, true); return { ...inputReceipt, outcome: 'unknown' } }
  const consumer = createSubmittedSecretConsumer({ ...f.options, consume })
  const running = consumer.execute(f.input)
  await inConsume
  await consumer.execute(f.input)
  let closed = false
  const closing = consumer.close().then(() => { closed = true })
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(closed, false)
  release(); await closing
  assert.equal(terminal, true); assert.equal((await running).outcome, 'unknown')
})

test('submitted: fixed SSH adapter sends JSON only in stdin, waits for receipt, clears buffer', async () => {
  let input, args
  const client = createSubmittedSecretRabbitClient({ project: '/fixed/project', run: async (command, argv, options) => {
    assert.equal(command, '/usr/bin/ssh'); args = argv; input = options.input
    assert.equal(argv.includes('-T'), true); assert.equal(argv.includes('StrictHostKeyChecking=yes'), true)
    assert.equal(argv.includes('kite'), true); assert.equal(argv.includes('rabbit'), true)
    assert.ok(!argv.join(' ').includes('synthetic-code'))
    assert.equal(JSON.parse(input).response.value, 'synthetic-code')
    assert.equal(options.maxBuffer, 4096)
    return { stdout: JSON.stringify(inputReceipt), stderr: '' }
  } })
  assert.deepEqual(await client({ ...challenge, response: { kind: 'authorization_code', value: 'synthetic-code' } }, { assertBeforeIssue() {} }), inputReceipt)
  assert.ok(input.every(byte => byte === 0))
  const program = args.at(-1).slice("python3 -c '".length, -1).replaceAll("'\\''", "'")
  const mock = `import urllib.request,json\nclass Answer:\n status=200\n def __enter__(self): return self\n def __exit__(self,*args): pass\n def read(self,limit): return b'{"harness":"claude","auth":{"status":"authenticated"}}'\nclass Opener:\n count=0\n def open(self,request,timeout):\n  self.count+=1\n  assert self.count==1 and timeout==60\n  assert request.full_url=='http://127.0.0.9:18891/api/setup/auth/input'\n  assert request.get_method()=='POST'\n  assert json.loads(request.data)['response']['value']=='synthetic-code'\n  return Answer()\nurllib.request.build_opener=lambda *args: Opener()\n`
  const python = spawnSync('python3', ['-c', mock + program], { input: JSON.stringify({ ...challenge, response: { kind: 'authorization_code', value: 'synthetic-code' } }), encoding: 'utf8' })
  assert.equal(python.status, 0); assert.equal(python.stderr, '')
  assert.deepEqual(JSON.parse(python.stdout), inputReceipt)
})

test('submitted: SSH stderr, rejection and malformed output never expose raw output', async () => {
  for (const run of [async () => ({ stdout: JSON.stringify(inputReceipt), stderr: 'sensitive diagnostic' }), async () => { throw new Error('sensitive diagnostic') }, async () => ({ stdout: 'sensitive diagnostic', stderr: '' })]) {
    const client = createSubmittedSecretRabbitClient({ project: '/fixed/project', run })
    const result = await client({ ...challenge, response: { kind: 'authorization_code', value: 'synthetic-code' } }, { assertBeforeIssue() {} })
    assert.equal(result.outcome, 'unknown'); assert.ok(!JSON.stringify(result).includes('sensitive'))
  }
})

test('submitted: fixed remote projects errors and invalid responses without raw body or retries', async () => {
  let command
  const client = createSubmittedSecretRabbitClient({ project: '/fixed/project', run: async (_, args) => {
    command = args.at(-1); return { stdout: JSON.stringify(inputReceipt), stderr: '' }
  } })
  await client({ ...challenge, response: { kind: 'authorization_code', value: 'synthetic-code' } }, { assertBeforeIssue() {} })
  const program = command.slice("python3 -c '".length, -1).replaceAll("'\\''", "'")
  for (const mode of ['redirect', 'oversize', 'wrong-harness']) {
    const mock = `import urllib.request,urllib.error,io\nclass Answer:\n status=200\n def __enter__(self): return self\n def __exit__(self,*args): pass\n def read(self,limit): return b'x'*32769 if '${mode}'=='oversize' else b'{"harness":"other","auth":{"status":"authenticated"},"secret":"synthetic-code"}'\nclass Opener:\n count=0\n def open(self,request,timeout):\n  self.count+=1\n  assert self.count==1\n  if '${mode}'=='redirect': raise urllib.error.HTTPError(request.full_url,302,'synthetic-code',{},io.BytesIO(b'synthetic-code'))\n  return Answer()\nurllib.request.build_opener=lambda *args: Opener()\n`
    const python = spawnSync('python3', ['-c', mock + program], { input: JSON.stringify({ ...challenge, response: { kind: 'authorization_code', value: 'synthetic-code' } }), encoding: 'utf8' })
    assert.equal(python.status, 0); assert.equal(python.stderr, '')
    assert.equal(JSON.parse(python.stdout).outcome, 'unknown')
    assert.ok(!python.stdout.includes('synthetic-code'))
  }
})

async function http(input, options = {}) {
  const request = Readable.from([Buffer.from(JSON.stringify(input))])
  request.method = options.method ?? 'POST'; request.headers = { 'content-type': 'application/json' }
  let status, body
  const response = { writeHead(code) { status = code }, end(value) { body = JSON.parse(value) } }
  let calls = 0, captures = 0
  const admission = Object.freeze({})
  const handler = createUsageApi({ internal: options.internal ?? true, secretRequests: {},
    submittedSecretConsumer: options.missing ? undefined : { execute: async args => { calls++; assert.equal(args.admission, admission); return { outcome: 'issued' } } },
    captureSubmittedSecretContext: async () => { captures++; if (options.deny) throw new Error('forbidden'); return admission } })
  await handler(request, response, new URL('http://local/api/secret-requests/abc-123/consume-claude-code'))
  return { status, body, calls, captures }
}

test('submitted: internal route captures admission, rejects public/missing and keeps setup input forbidden', async () => {
  assert.deepEqual(await http(challenge), { status: 200, body: { receipt: { outcome: 'issued' } }, calls: 1, captures: 1 })
  assert.equal((await http(challenge, { internal: false })).status, 403)
  assert.equal((await http(challenge, { missing: true })).status, 503)
  assert.equal((await http(challenge, { method: 'GET' })).status, 405)
  assert.equal((await http(challenge, { deny: true })).status, 403)
  assert.equal((await http({ ...challenge, value: 'forbidden' })).status, 400)
  const handler = createUsageApi({ internal: true, onboarding: {} })
  let status
  await handler({ method: 'POST' }, { writeHead(code) { status = code }, end() {} }, new URL('http://local/api/setup/auth/input'))
  assert.equal(status, 403)
})
