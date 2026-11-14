import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { spawn } from 'node:child_process'
import { seatCommandSpec } from '/app/src/seat-command.mjs'
import { runResumePipe } from '/app/src/resume-pipe.mjs'

const base = '/srv/bellteam-aiterm', home = '/home/bell', restored = `${home}/h1-restored-checkpoint`
// Same literal as STUB_CHECKPOINT in resume-state-contract-stub.mjs (the guest runs without the repo).
const stubBytes = 'h1 synthetic checkpoint\n'
const target = { session_id: 'offline', launch_id: 'a'.repeat(32) }
const digest = bytes => createHash('sha256').update(bytes).digest('hex')
const json = async path => JSON.parse(await fs.readFile(path, 'utf8'))
const mode = process.argv[2]
if (mode === 'initialize') {
  assert.equal(process.getuid(), 0)
  for (const path of ['/fixture-runtime/home', '/fixture-runtime/data', '/private/state']) {
    await fs.mkdir(path, { recursive: true })
    const uid = path.startsWith('/private') ? 1001 : 1000
    await fs.chown(path, uid, uid); await fs.chmod(path, path.endsWith('/data') ? 0o755 : 0o700)
  }
  await fs.chown('/private', 0, 1001); await fs.chmod('/private', 0o750)
  await fs.chown(base, 1000, 1000); await fs.chmod(base, 0o700)
} else if (mode === 'identity-signal') {
  assert.equal(process.getuid(), 1001)
  const code = `const a=require('node:assert/strict'),f=require('node:fs');
    a.equal(process.getuid(),1000);a.equal(process.geteuid(),1000);a.equal(process.getgid(),1000);
    const status=f.readFileSync('/proc/self/status','utf8');
    a.match(status,/^Uid:\\s+1000\\s+1000\\s+1000\\s+1000$/m);
    a.match(status,/^Gid:\\s+1000\\s+1000\\s+1000\\s+1000$/m);
    a.match(status,/^Groups:\\s*$/m);a.equal(process.env.AITERM_STATE_BASE,'/srv/bellteam-aiterm');
    a.equal(process.env.BELLTEAM_BUGHUB_KEY,undefined);
    a.throws(()=>f.readFileSync('/srv/bellteam/state/resume-checkpoints/fixture/generation.json'),{code:'EACCES'});
    for(const fd of [3,4]){try{const p=f.readlinkSync('/proc/self/fd/'+fd);a.ok(!p.includes('/srv/bellteam/state')&&!p.includes('/run/bellteam-maintenance'))}catch(e){if(e.code!=='ENOENT')throw e}}
    console.log('UID_BOUNDARY_OK')`
  const spec = seatCommandSpec(process.execPath, ['-e', code], { project: '/srv/bellteam', environment: 'base' })
  const child = spawn(spec.command, spec.args, { env: spec.env, stdio: ['ignore', 'pipe', 'pipe'] })
  let output = '', errors = ''
  child.stdout.on('data', b => { output += b }); child.stderr.on('data', b => { errors += b })
  assert.equal(await new Promise((resolve, reject) => { child.once('error', reject); child.once('close', resolve) }), 0)
  assert.equal(output.trim(), 'UID_BOUNDARY_OK')
  assert.equal(errors, '', 'seat transport must preserve an empty stderr for restore')
  const pidfile = '/srv/bellteam/signal-pids.json'
  const stubborn = `const {spawn}=require('node:child_process');process.on('SIGTERM',()=>{});
    const c=spawn(process.execPath,['-e',"process.on('SIGTERM',()=>{});setInterval(()=>{},1000)"],{stdio:'ignore'});
    require('node:fs').writeFileSync('${pidfile}',JSON.stringify([process.pid,c.pid]),{mode:0o644});setInterval(()=>{},1000)`
  const controller = new AbortController()
  const pending = runResumePipe(seatCommandSpec(process.execPath, ['-e', stubborn],
    { project: '/srv/bellteam', environment: 'base' }), 'checkpoint', target, { signal: controller.signal })
  // Observe readiness before cancellation so startup timing cannot pass the signal check.
  let pids
  for (let n = 0; n < 100; n++) {
    try { pids = await json(pidfile); break } catch (e) { if (e.code !== 'ENOENT') throw e }
    await new Promise(resolve => setTimeout(resolve, 50))
  }
  assert.ok(pids, 'signal child never became ready'); controller.abort()
  await assert.rejects(pending, { code: 'ABORT_ERR' })
  for (const pid of pids) {
    for (let n = 0; n < 50; n++) {
      try { process.kill(pid, 0) } catch (error) { if (error.code === 'ESRCH') break; if (error.code !== 'EPERM') throw error }
      await new Promise(resolve => setTimeout(resolve, 20))
    }
    assert.throws(() => process.kill(pid, 0), { code: 'ESRCH' })
  }
  console.log(JSON.stringify({ uidBoundary: true, privateDenied: true, signalGroupReaped: true }))
} else if (mode === 'verify') {
  const st = await fs.stat(restored)
  assert.equal(st.uid, 1000); assert.equal(st.mode & 0o777, 0o600)
  assert.equal(digest(await fs.readFile(restored)), digest(stubBytes))
  console.log(JSON.stringify({ restoredFile: true, exactBytes: true }))
} else if (mode === 'source-empty') {
  assert.equal(process.getuid(), 1000)
  assert.deepEqual(await fs.readdir(base), [])
  console.log(JSON.stringify({ sourceStateUntouched: true }))
} else if (mode === 'private-check') {
  assert.equal(process.getuid(), 1001)
  const root = '/srv/bellteam/state/resume-checkpoints/fixture'
  const plan = await json(`${root}/generation.json`)
  const item = plan.targets[0], bytes = await fs.readFile(`${root}/${item.file}`)
  assert.equal(digest(bytes), item.checkpoint_sha256); assert.equal(bytes.toString(), stubBytes)
  for (const path of [root, `${root}/${item.file}`, `${root}/generation.json`]) {
    const st = await fs.stat(path); assert.equal(st.uid, 1001)
    assert.equal(st.mode & 0o777, st.isDirectory() ? 0o700 : 0o600)
    if (st.isFile()) assert.equal(st.nlink, 1)
  }
  console.log(JSON.stringify({ savedBytes: bytes.length, sha256: digest(bytes), privateUid: 1001, privateModes: true }))
} else if (mode === 'adopted') {
  const root = '/srv/bellteam/state/resume-checkpoints/fixture'
  assert.equal((await json(`${root}/adopted.json`)).generation_sha256, digest(await fs.readFile(`${root}/generation.json`)))
  console.log(JSON.stringify({ adopted: true }))
} else if (mode === 'damage') {
  const root = '/srv/bellteam/state/resume-checkpoints/fixture'
  const plan = await json(`${root}/generation.json`)
  await fs.unlink(`${root}/adopted.json`); await fs.unlink(`${root}/started.json`)
  await fs.writeFile(`${root}/${plan.targets[0].file}`, 'broken\n')
} else if (mode === 'rejected') {
  const root = '/srv/bellteam/state/resume-checkpoints/fixture'
  await assert.rejects(fs.stat(`${root}/adopted.json`), { code: 'ENOENT' })
  assert.ok((await fs.stat(`${root}/started.json`)).isFile())
  console.log(JSON.stringify({ failedRestoreAdopted: false }))
} else if (mode === 'mark') {
  await fs.writeFile(restored, 'changed after bootstrap boundary\n')
} else if (mode === 'check-mark') {
  assert.equal(await fs.readFile(restored, 'utf8'), 'changed after bootstrap boundary\n')
  console.log(JSON.stringify({ replayed: false }))
} else if (mode === 'cleanup') {
  for (const name of await fs.readdir('/fixture-runtime')) await fs.rm(`/fixture-runtime/${name}`, { recursive: true, force: true })
} else throw Error('unknown fixture mode')
