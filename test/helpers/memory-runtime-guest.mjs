// Artificial data/bootstrap only; the facade, C seat entry, runner and signed code are image bytes.
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { mkdir, writeFile, readFile, stat, chown, chmod, rename } from 'node:fs/promises'
import { setTimeout as delay } from 'node:timers/promises'
import { createServer } from 'node:http'
import { SeatRuntime } from '/app/src/seat-runtime.mjs'
import { createSeatProcessRunner } from '/app/src/seat-process.mjs'
import { createHttpGatewayProcess } from '/app/src/http-gateway-process.mjs'
import { prepareServerStateRuntime } from '/app/src/server-state-transfer.mjs'

const mode = process.argv[2] ?? 'runtime'
const root = '/srv/bellteam', state = `${root}/state`, project = `${root}/bots/bot-memory-fixture`
const statusPath = `${state}/fixture-status.json`, commandPath = `${state}/fixture-command.json`
const write = (path, value) => writeFile(path, JSON.stringify(value) + '\n', { mode: 0o600 })
if (mode === 'initialize') {
  assert.equal(process.getuid(), 0)
  for (const part of ['data', 'data/shared', 'data/shared/tools', 'data/bots']) {
    const path = '/fixture-runtime/' + part
    await mkdir(path, { recursive: true }); await chown(path, 1001, 1001); await chmod(path, 0o755)
  }
  for (const part of ['home', 'data/bots/bot-memory-fixture']) {
    const path = '/fixture-runtime/' + part
    await mkdir(path, { recursive: true }); await chown(path, 1000, 1000); await chmod(path, 0o700)
  }
  // Real initial prepare creates the code root; no fixture substitute for that owner operation.
  const prepare = await prepareServerStateRuntime({ root: '/fixture-runtime', privateRoot: '/private' })
  const receipt = await readFile('/private/.prepared.json'), receiptStat = await stat('/private/.prepared.json')
  assert.equal((await prepareServerStateRuntime({ root: '/fixture-runtime', privateRoot: '/private' })).status, 'already-prepared')
  assert.deepEqual(await readFile('/private/.prepared.json'), receipt)
  assert.equal((await stat('/private/.prepared.json')).ino, receiptStat.ino)
  for (const part of ['state', 'rooms', 'owner', 'logs', 'bellteam-settings', 'apns']) {
    const path = '/private/' + part
    await mkdir(path, { recursive: true }); await chown(path, 1001, 1001); await chmod(path, 0o700)
  }
  const code = await stat('/private/memory-code'), control = await stat('/private')
  assert.deepEqual([code.uid, code.gid, code.mode & 4095], [0, 0, 0o555])
  assert.deepEqual([control.uid, control.gid, control.mode & 4095], [0, 1001, 0o750])
  console.log(JSON.stringify({ prepare, secondPrepareRetainsReceipt: true, codeRoot: '0:0/0555', private: '0:1001/0750' }))
} else if (mode === 'status') {
  console.log(await readFile(statusPath, 'utf8'))
} else if (mode === 'command') {
  const action = process.argv[3]
  assert.ok(['adopt-b', 'return-a', 'finish'].includes(action))
  await write(commandPath, { action })
} else {
  assert.equal(mode, 'runtime'); assert.equal(process.getuid(), 1001); assert.equal(process.getgid(), 1001)
  assert.equal(Number(process.versions.node.split('.')[0]), 26)
  await assert.rejects(writeFile('/app/fixture-readonly', 'x'), { code: 'EROFS' })
  const ids = JSON.parse(await readFile('/fixture-input.json', 'utf8'))
  assert.match(ids.b, /^[a-f0-9]{64}$/); assert.match(ids.source, /^[a-f0-9]{40}$/)
  const binary = await stat('/usr/local/libexec/bellteam-seat-exec')
  assert.deepEqual([binary.uid, binary.gid, binary.mode & 4095], [0, 0, 0o755])
  const realRun = createSeatProcessRunner(root, { environment: 'base' }), events = []
  const progress = stage => write(statusPath, { phase: 'starting', stage, events })
  // Record the existing runner's real close promise; do not replace its output, delay or cancellation.
  const run = async (command, args, options) => {
    const request = JSON.parse(options.input), call = { entry: args[0], method: request.method, generation: request.generation }
    const before = request.method === null ? await dataHashes() : null
    events.push({ event: 'start', ...call })
    await progress('seat-run')
    const result = await realRun(command, args, options)
    events.push({ event: 'os-stdio-close', ...call })
    await progress('seat-closed')
    if (before) assert.deepEqual(await dataHashes(), before, 'restore preserves every DB/notes byte')
    return result
  }
  const seat = new SeatRuntime({ root, home: '/home/bell', run })
  const controller = seat.memoryModule
  const memory = seat.memory(new Map([['bot-memory-fixture', { id: 'bot-memory-fixture', project }]]))
  const params = { botId: 'bot-memory-fixture' }
  const seatEval = async source => JSON.parse((await realRun(process.execPath, ['--input-type=module', '-e', source])).stdout)
  const dataHashes = () => seatEval(`
    import { readdir,readFile,lstat } from 'node:fs/promises'; import {createHash} from 'node:crypto';
    const result={}; async function walk(path){for(const name of (await readdir(path)).sort()){
      const file=path+'/'+name, st=await lstat(file); if(st.isDirectory())await walk(file);
      else {if(!st.isFile()||st.uid!==1000)throw Error('DATA_IDENTITY');result[file]=createHash('sha256').update(await readFile(file)).digest('hex')}}}
    await walk(${JSON.stringify(project)}); console.log(JSON.stringify(result));`)
  let business, businessIdentity, gatewayIdentity, port, base, currentDataPreserved = false, codeViewVerified = false
  const identity = async pid => ({ pid, startTime: (await readFile(`/proc/${pid}/stat`, 'utf8')).split(') ')[1].split(' ')[19] })
  const childIdentity = async entry => {
    const children = (await readFile(`/proc/${process.pid}/task/${process.pid}/children`, 'utf8')).trim().split(/ +/u).filter(Boolean)
    const matches = []
    for (const pid of children) {
      const command = await readFile(`/proc/${pid}/cmdline`, 'utf8').catch(error => { if (error.code === 'ENOENT') return ''; throw error })
      if (command.includes(entry)) matches.push(Number(pid))
    }
    assert.equal(matches.length, 1, entry); return identity(matches[0])
  }
  const parentIdentity = await identity(process.pid)
  const server = createServer((_request, response) => { response.writeHead(200); response.end('fixture') })
  const socketPath = '/run/bellteam-server/memory-fixture.sock'
  const gateway = createHttpGatewayProcess({ socketPath, port: 0, appRoot: '/app' })
  const checks = []
  const invariant = async () => {
    assert.deepEqual(await identity(process.pid), parentIdentity)
    assert.deepEqual(await identity(business.pid), businessIdentity)
    assert.deepEqual(await childIdentity('src/http-gateway-entry.mjs'), gatewayIdentity)
    assert.equal(gateway.address.port, port)
    assert.equal((await fetch(base + '/api/fixture')).status, 200)
  }
  const publish = async phase => {
    await invariant()
    const snapshot = controller.snapshot(); assert.equal(snapshot.available, true)
    await write(statusPath + '.tmp', { ...snapshot, runtimePhase: snapshot.phase, phase, checks, events, parent: parentIdentity, business: businessIdentity,
      gateway: gatewayIdentity, port, currentDataPreserved, codeViewVerified,
      realSeatCloseBeforeRestore: checks.filter(item => item.oldCloseBeforeRestore).length === 2 })
    await rename(statusPath + '.tmp', statusPath)
  }
  const command = async action => {
    const deadline = Date.now() + 150000
    while (Date.now() < deadline) {
      const value = await readFile(commandPath, 'utf8').then(JSON.parse).catch(error => { if (error.code === 'ENOENT') return null; throw error })
      if (value?.action === action) return
      await delay(50)
    }
    throw Error('MEMORY_FIXTURE_COMMAND_TIMEOUT')
  }
  const selectWithWriter = async target => {
    const previous = controller.snapshot(), first = events.length
    const writing = memory.remember({ ...params, content: 'finite-writer-' + target })
    // Wait for actual runner invocation, not completion, before requesting replacement.
    while (events.length === first) await delay(0)
    assert.equal(events[first].method, 'remember')
    const replacing = controller.replace(target)
    const saved = await writing
    await replacing
    const selected = controller.snapshot()
    assert.equal(selected.currentVersionId, target === 'builtin' ? null : target)
    assert.notEqual(selected.generation, previous.generation)
    const slice = events.slice(first)
    const ended = slice.findIndex(item => item.event === 'os-stdio-close' && item.method === 'remember' && item.generation === previous.generation)
    const restored = slice.findIndex(item => item.event === 'start' && item.method === null && item.generation === selected.generation)
    assert.ok(ended >= 0 && restored > ended)
    assert.equal(slice.filter(item => item.event === 'start' && item.method === 'remember').length, 1)
    assert.equal(slice[restored].entry, target === 'builtin' ? '/app/src/run-memory-runtime.mjs' : `/run/bellteam-memory-code/${target}/payload/src/run-memory-runtime.mjs`)
    const adoption = JSON.parse(await readFile(`${state}/memory-release.json`, 'utf8')), info = await stat(`${state}/memory-release.json`)
    assert.equal(adoption.currentVersionId, selected.currentVersionId)
    assert.deepEqual([info.uid, info.gid, info.mode & 4095, info.nlink], [1001, 1001, 0o600, 1])
    const recalled = await memory.recallMemory({ ...params, query: 'finite-writer' })
    assert.ok(recalled.items.some(item => item.id === saved.id))
    checks.push({ target, adoption, oldCloseBeforeRestore: true, noMutationReplay: true, writerId: saved.id })
  }
  try {
    await progress('controller-start')
    await controller.start()
    await progress('initial-data-hashes')
    assert.deepEqual(await dataHashes(), {}, 'restore does not initialize business data')
    await progress('ensure-scope')
    await memory.ensureScope(params.botId, 'personal')
    await progress('remember')
    const first = await memory.remember({ ...params, content: 'retained-memory-before-exchange' })
    await progress('record-knowledge')
    const note = await memory.recordKnowledge({ ...params, title: 'retained-knowledge', content: 'retained-knowledge-before-exchange' })
    await progress('gateway-start')
    await new Promise(resolve => server.listen(socketPath, resolve)); await gateway.start()
    port = gateway.address.port; base = `http://127.0.0.1:${port}`
    business = spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { env: {}, stdio: 'ignore' })
    await once(business, 'spawn'); businessIdentity = await identity(business.pid)
    gatewayIdentity = await childIdentity('src/http-gateway-entry.mjs')
    await publish('ready'); await command('adopt-b')
    const manifest = JSON.parse(await readFile(`/run/bellteam-maintenance/memory/releases/${ids.b}/manifest.json`, 'utf8'))
    const verifyView = `import assert from 'node:assert/strict'; import {readFile,writeFile,lstat} from 'node:fs/promises';import{createHash}from'node:crypto';
      const uid=process.getuid(); assert.ok([1000,1001].includes(uid));
      for(const row of ${JSON.stringify(manifest.files)}){const file='/run/bellteam-memory-code/${ids.b}/'+row.path,st=await lstat(file),b=await readFile(file);
        assert.equal(st.uid,0);assert.equal(st.gid,0);assert.equal(st.mode&4095,0o444);assert.equal(st.nlink,1);assert.equal(b.length,row.bytes);
        assert.equal(createHash('sha256').update(b).digest('hex'),row.sha256);
        await assert.rejects(writeFile(file,'x'),e=>['EROFS','EACCES'].includes(e.code));}
      if(uid===1000)await assert.rejects(readFile('/run/bellteam-maintenance/memory/releases/${ids.b}/installation.json'),{code:'EACCES'});
      console.log(JSON.stringify({uid,codeReadable:true,writeDenied:true,privateDenied:uid===1000}));`
    const seatView = await seatEval(verifyView)
    // Same fixed test source in parent UID1001, with no seat-private state exported.
    const parentView = spawn(process.execPath, ['--input-type=module', '-e', verifyView], { env: {}, stdio: ['ignore', 'pipe', 'pipe'] })
    const parentOutput = []; parentView.stdout.on('data', chunk => parentOutput.push(chunk))
    assert.deepEqual(await once(parentView, 'close'), [0, null])
    checks.push({ codeView: [seatView, JSON.parse(Buffer.concat(parentOutput))] }); codeViewVerified = true
    await selectWithWriter(ids.b)
    const revised = await memory.reviseMemory({ ...params, id: first.id, content: 'retained-memory-after-exchange' })
    await memory.recordKnowledge({ ...params, title: 'new-knowledge', content: 'new-knowledge-on-signed' })
    const beforeReturn = await dataHashes()
    await publish('b-active'); await command('return-a'); await selectWithWriter('builtin')
    const afterReturn = await dataHashes()
    // The final writer changes memory.db intentionally; notes must retain their exact latest bytes.
    for (const [path, digest] of Object.entries(beforeReturn).filter(([path]) => path.endsWith('.md'))) assert.equal(afterReturn[path], digest)
    assert.ok((await memory.recallMemory({ ...params, query: 'retained-memory-after-exchange' })).items.some(item => item.id === revised.id))
    assert.ok((await memory.searchKnowledge({ ...params, query: 'retained-knowledge' })).items.some(item => item.id === note.id))
    assert.ok((await memory.searchKnowledge({ ...params, query: 'new-knowledge' })).items.length > 0)
    currentDataPreserved = true
    checks.push({ latestDataAndNotesPreserved: true, beforeReturn, afterReturn })
    await publish('done'); await command('finish')
    await controller.close(); await gateway.close(); business.kill('SIGTERM'); await once(business, 'close')
    await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()))
    assert.equal(controller.snapshot().phase, 'closed')
    assert.equal(events.filter(item => item.event === 'start').length, events.filter(item => item.event === 'os-stdio-close').length)
    await assert.rejects(memory.remember({ ...params, content: 'must-not-run' }), { code: 'MEMORY_CLOSED' })
    await write(statusPath, { phase: 'closed', memoryChildrenEnded: true, gatewayAndBusinessClosed: true, events })
    setInterval(() => {}, 1000); await new Promise(() => {})
  } catch (error) {
    await write(statusPath, { phase: 'failed', error: error.stack, checks, events }); throw error
  }
}
