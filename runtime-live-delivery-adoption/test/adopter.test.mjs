import test from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtemp, readFile, rm, symlink, writeFile, mkdir } from 'node:fs/promises'
import { join, dirname } from 'node:path'
import { createRequire, registerHooks } from 'node:module'
import { pathToFileURL } from 'node:url'
import { BASE, digest, prepareDescriptorChanges, saveExclusive, trustedFile, validateProfile, commitPreparedPolicy } from '../src/adopter.mjs'

const product = dirname(import.meta.dirname)
const profile = JSON.parse(await readFile(join(product, 'profile/source.json')))

test('exclusive durable records reject reuse, changed bytes and links', async () => {
  const root = await mkdtemp(join(import.meta.dirname, '.record-fixture-'))
  try {
    const path = join(root, 'intent.json')
    await saveExclusive(path, { issued: true })
    const original = await readFile(path)
    await assert.rejects(saveExclusive(path, { issued: false }), { code: 'EEXIST' })
    assert.deepEqual(await readFile(path), original)
    assert.deepEqual(await trustedFile(path, 1024, process.getuid(), digest(original)), original)
    await assert.rejects(trustedFile(path, 1024, process.getuid(), '0'.repeat(64)), { code: 'LIVE_FILE_CHANGED' })
    await symlink(path, join(root, 'link'))
    await assert.rejects(trustedFile(join(root, 'link'), 1024, process.getuid()), { code: 'ELOOP' })
    const invalid = structuredClone(profile)
    invalid.modules[0].methods.push(invalid.modules[0].methods[0])
    assert.throws(() => validateProfile(invalid), { code: 'LIVE_PROFILE_INVALID' })
  } finally { await rm(root, { recursive: true, force: true }) }
})

test('lost post-commit receipt keeps the real applied state and refuses the same intent', async () => {
  const root = await mkdtemp(join(import.meta.dirname, '.receipt-failure-fixture-'))
  let commits = 0, applied = false
  try {
    const transaction = { commit() { commits++; applied = true; return [] } }
    await mkdir(join(root, 'receipt.json'))
    await assert.rejects(commitPreparedPolicy(root, { operationSha256: '1'.repeat(64) }, transaction), { code: 'EEXIST' })
    assert.equal(applied, true)
    assert.equal(commits, 1)
    assert.equal(JSON.parse(await readFile(join(root, 'intent.json'))).operationSha256, '1'.repeat(64))
    await assert.rejects(commitPreparedPolicy(root, { operationSha256: '1'.repeat(64) }, transaction), { code: 'EEXIST' })
    assert.equal(commits, 1)
  } finally { await rm(root, { recursive: true, force: true }) }
})

test('real 421d transport adopts seven descriptors with old owners alive and one new native input', async () => {
  const repo = process.env.BELLTEAM_SOURCE_REPO
  const dependencies = process.env.BELLTEAM_NODE_MODULES
  assert.ok(repo && dependencies, 'set BELLTEAM_SOURCE_REPO and BELLTEAM_NODE_MODULES for the author-only exact-base check')
  const root = await mkdtemp(join(import.meta.dirname, '.transport-fixture-'))
  let hook, transport, old, native
  try {
    const git = (...args) => execFileSync('git', ['-C', repo, ...args])
    const contract = git('show', `${BASE}:scripts/web_gateway_artifact.py`)
    const paths = JSON.parse(execFileSync('python3', ['-B', '-c', `import ast,json,sys
t=ast.parse(sys.stdin.read())
n=next(n for n in t.body if isinstance(n,ast.Assign) and any(isinstance(x,ast.Name) and x.id=='EXECUTION_FILES' for x in n.targets))
print(json.dumps(ast.literal_eval(n.value.generators[0].iter)))`], { input: contract }))
    const archive = git('archive', BASE, ...paths, 'src/conversation-lifetimes.mjs')
    execFileSync('python3', ['-B', '-c', `import io,sys,tarfile
with tarfile.open(fileobj=io.BytesIO(sys.stdin.buffer.read())) as t:
 assert all(m.isfile() or m.isdir() for m in t.getmembers())
 t.extractall(sys.argv[1],filter='data')`, root], { input: archive })
    assert.equal(digest(await readFile(join(root, 'package-lock.json'))), digest(await readFile(join(dirname(dependencies), 'package-lock.json'))))
    await symlink(dependencies, join(root, 'node_modules'))
    await mkdir(join(root, 'policy'))
    for (const module of profile.modules) {
      const raw = await readFile(join(product, 'profile', module.file))
      const projected = execFileSync('python3', ['-B', '-c', `import sys
sys.path.insert(0,sys.argv[1])
from package import project_imports
sys.stdout.buffer.write(project_imports(sys.stdin.buffer.read(),sys.argv[2]))`, product, module.file], { input: raw })
      await writeFile(join(root, 'policy', module.file), projected)
    }
    const original = {}, repaired = {}, require = createRequire(join(root, 'package.json'))
    for (const module of profile.modules) {
      const path = join(root, 'src', module.file)
      assert.equal(digest(await readFile(path)), module.beforeFileSha256)
      const imported = await import(pathToFileURL(path).href)
      assert.equal(require(path)[module.class], imported[module.class])
      original[module.class] = imported[module.class]
    }
    hook = registerHooks({ resolve(specifier, context, next) {
      if (specifier.startsWith('file:///app/src/')) return next(pathToFileURL(join(root, 'src', specifier.slice('file:///app/src/'.length))).href, context)
      return next(specifier, context)
    } })
    for (const module of profile.modules) repaired[module.class] = require(join(root, 'policy', module.file))[module.class]
    const { ConversationLifetimes } = require(join(root, 'src/conversation-lifetimes.mjs'))
    const bot = { id: 'fixture-quincy', name: 'Quincy', session: 'quincy' }
    native = Promise.withResolvers(); old = Promise.withResolvers()
    const calls = [], statuses = []
    let oldCallbackCount = 0
    const oldCallback = () => { oldCallbackCount++ }
    const oldFollow = old.promise.then(oldCallback)
    transport = new original.AitermTransport({ conversationAdmission: new ConversationLifetimes('current'), handoffContext: async () => '',
      waitProcess: () => native.promise, client: { async call(name, args) {
        calls.push({ name, args })
        if (name === 'pty_list') return { content: [{ type: 'text', text: 'quincy' }] }
        if (name === 'pty_send') return { structuredContent: { mode: 'agent_dispatch', event_cursor: 1, wait_process: { executable: 'fixture', args: [] } } }
        if (name === 'pty_read') return { structuredContent: { schema: 'aiterm.pty-read-result.v1', mode: 'agent_transcript', turn_id: 'new', text: 'reply' } }
        if (name === 'pty_observe') return {}
        assert.fail('unexpected native operation ' + name)
      }, async close() {} } })
    const occupied = { id: 'old-job', bot, conversationGeneration: 'retired', nativeUnconfirmed: Error('old unknown'),
      info: { message: 'old payload must not replay' }, completion: old.promise, callback: oldCallback }
    transport.activity.register(occupied); transport.activity.admit(occupied)
    transport.uncertainChanges.set(bot.id, 'pty_close')
    const held = { instance: transport, state: transport.sessionState, jobs: transport.activity.jobs,
      active: transport.active, watches: transport.watches, uncertainty: transport.uncertainChanges,
      version: transport.uncertainChanges.version(bot.id), client: transport.client, follow: oldFollow }
    assert.throws(() => transport.turn(bot, 'pre-adoption', { onStatus() {} }), { code: 'CONVERSATION_NOT_ACCEPTED' })
    const bad = structuredClone(profile); bad.modules[1].methods[0].before.sha256 = '0'.repeat(64)
    const oldSubmit = original.AitermTransport.prototype.submit
    assert.throws(() => prepareDescriptorChanges(bad, original, repaired), { code: 'LIVE_METHOD_FINGERPRINT_CHANGED' })
    assert.equal(original.AitermTransport.prototype.submit, oldSubmit)
    const transaction = prepareDescriptorChanges(profile, original, repaired)
    const rows = transaction.commit()
    assert.equal(rows.length, 7)
    assert.throws(() => transaction.commit(), { code: 'LIVE_COMMIT_ALREADY_ISSUED' })
    assert.equal(transport, held.instance); assert.equal(transport.sessionState, held.state)
    assert.equal(transport.activity.jobs, held.jobs); assert.equal(transport.active, held.active)
    assert.equal(transport.watches, held.watches); assert.equal(transport.client, held.client)
    assert.equal(transport.uncertainChanges, held.uncertainty)
    assert.equal(transport.uncertainChanges.version(bot.id), held.version)
    assert.equal(occupied.completion, old.promise); assert.equal(occupied.callback, oldCallback)
    assert.equal(oldCallbackCount, 0)
    transport.requireDeliveryKnown(bot.id); transport.sessionState.requireDeliveryKnown(bot.id)
    assert.throws(() => transport.requireSessionKnown(bot.id), { code: 'BOT_SESSION_UNCONFIRMED' })
    const delivery = transport.turn(bot, 'new input', { onStatus: status => statuses.push(status) })
    assert.equal((await delivery.accepted).delivery, 'running')
    assert.equal(calls.filter(call => call.name === 'pty_send').length, 1)
    assert.ok(!JSON.stringify(calls).includes(occupied.info.message))
    native.resolve({ outcome: 'done', turn_id: 'new' })
    assert.equal(await delivery, 'reply')
    old.resolve(); await oldFollow
    assert.equal(oldCallbackCount, 1)
    transport.activity.release(occupied)
    assert.ok(statuses.includes('running'))
  } finally {
    native?.resolve({ outcome: 'done', turn_id: 'new' }); old?.resolve()
    if (transport) { for (const job of [...transport.activity.jobs]) transport.activity.release(job); await transport.close() }
    hook?.deregister()
    await rm(root, { recursive: true, force: true })
  }
})
