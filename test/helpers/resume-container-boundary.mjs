import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { spawn } from 'node:child_process'
import { seatCommandSpec } from '/app/src/seat-command.mjs'
import { runResumePipe } from '/app/src/resume-pipe.mjs'

const base = '/srv/bellteam-aiterm', home = '/home/bell', codex = `${home}/.codex`
const dist = '/usr/local/lib/node_modules/aiterm-mcp/dist'
const target = { session_id: 'offline', launch_id: 'a'.repeat(32) }
const digest = bytes => createHash('sha256').update(bytes).digest('hex')
const json = async path => JSON.parse(await fs.readFile(path, 'utf8'))
const write = (path, value) => fs.writeFile(path, JSON.stringify(value) + '\n', { mode: 0o600 })
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
} else if (mode === 'seed') {
  assert.equal(process.getuid(), 1000)
  const agents = `${base}/aiterm-mcp-1000/agents`, id = target.launch_id
  for (const path of [codex, `${codex}/sessions`, agents]) await fs.mkdir(path, { recursive: true, mode: 0o700 })
  const file = `${codex}/sessions/root.jsonl`, retained = Buffer.from('synthetic offline rollout\n')
  await fs.writeFile(file, retained, { mode: 0o600 })
  const st = await fs.stat(file), socket = '/tmp/claude-tmux-sockets/claude.sock'
  const vendor = '11111111-2222-4333-8444-555555555555'
  const recipe = { schema: 'aiterm.agent-resume.v1', launch_id: id, kind: 'codex', vendor_session_id: vendor,
    executable: '/synthetic/codex-never-run', cwd: home, configuration_root: codex, model: 'sol', reasoning_effort: 'high', fast: false, environment: {} }
  const proof = { schema: 'aiterm.codex-resume-proof.v1', launch_id: id, session_id: vendor, file,
    device: String(st.dev), inode: String(st.ino), cursor: st.size, prefix_bytes: st.size,
    prefix_sha256: digest(retained), last_turn_id: 'synthetic' }
  const meta = { kind: 'codex', aiterm_session: target.session_id, launch_id: id,
    event_file: `${agents}/offline.${id}.events.jsonl`, created_at: '2026-11-02T15:00:00.000Z', cwd: home,
    vendor_session_id: vendor, initial_prompt: 'none', agent_executable: recipe.executable,
    hook_route: 'shared_codex_home', completion_route: 'codex_transcript', agent_role: 'subagent',
    parent_session_id: 'host-root', delegation_depth: 1, lineage: 'host-root>codex:offline',
    delegation_allowed: true, node_platform: 'linux', codex_home: codex, fast: false, model: 'sol' }
  const life = { schema: 'aiterm.agent-lifecycle.v1', launch_id: id, state: 'hibernated', socket,
    at: meta.created_at, anchor: 'synthetic', native_id: '$1',
    pane: { pid: 10, process_group_id: 10, started_identity: 'linux:1', argv_digest: '2'.repeat(64) },
    recipe_digest: digest(Buffer.from(JSON.stringify(recipe))), resume_proof_digest: digest(Buffer.from(JSON.stringify(proof))) }
  const { resumeCheckpointRecord, resumeCheckpointRecordPath } = await import(`${dist}/resume-checkpoint.js`)
  const scope = { ...target, uid: 1000, node_platform: 'linux', state_base: base, socket,
    configuration_root: codex, vendor_session_id: vendor }
  const files = []
  for (const [kind, value] of Object.entries({ generation: { schema: 'aiterm.agent-generation.v1', launch_id: id, previous_launch_id: null }, metadata: meta, recipe, proof, lifecycle: life })) {
    const bytes = Buffer.from(JSON.stringify(value, null, 2) + '\n')
    const path = resumeCheckpointRecordPath(scope, resumeCheckpointRecord(id, kind, bytes))
    await fs.writeFile(path, bytes, { mode: 0o600 }); files.push({ path, sha256: digest(bytes) })
  }
  await write(`${home}/fixture-manifest.json`, files)
  console.log(JSON.stringify({ seeded: true, uid: process.getuid(), rolloutDevice: String(st.dev), rolloutInode: String(st.ino) }))
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
  let output = ''; child.stdout.on('data', b => { output += b })
  assert.equal(await new Promise((resolve, reject) => { child.once('error', reject); child.once('close', resolve) }), 0)
  assert.equal(output.trim(), 'UID_BOUNDARY_OK')
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
  const files = await json(`${home}/fixture-manifest.json`)
  for (const item of files) assert.equal(digest(await fs.readFile(item.path)), item.sha256)
  console.log(JSON.stringify({ restoredFiles: files.length, exactBytes: true }))
} else if (mode === 'private-check') {
  assert.equal(process.getuid(), 1001)
  const root = '/srv/bellteam/state/resume-checkpoints/fixture'
  const plan = await json(`${root}/generation.json`)
  const item = plan.targets[0], bytes = await fs.readFile(`${root}/${item.file}`)
  assert.equal(digest(bytes), item.checkpoint_sha256)
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
  const files = await json(`${home}/fixture-manifest.json`)
  await fs.writeFile(files[0].path, 'changed after bootstrap boundary\n')
} else if (mode === 'check-mark') {
  const files = await json(`${home}/fixture-manifest.json`)
  assert.equal(await fs.readFile(files[0].path, 'utf8'), 'changed after bootstrap boundary\n')
  console.log(JSON.stringify({ replayed: false }))
} else if (mode === 'cleanup') {
  for (const name of await fs.readdir('/fixture-runtime')) await fs.rm(`/fixture-runtime/${name}`, { recursive: true, force: true })
} else throw Error('unknown fixture mode')
