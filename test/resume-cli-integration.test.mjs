import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile, readFile, rename, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { runResumePipe, resumeDigest } from '../src/resume-pipe.mjs'
import { saveResumeCheckpoint, publishResumeFile } from '../src/resume-storage.mjs'
import { adoptResumeGeneration } from '../src/resume-boot.mjs'

const dist = process.env.BELLTEAM_TEST_AITERM_DIST
test('fixed real H1 CLI: checkpoint/private publication/different backing/restore/adoption without native startup', { skip: !dist }, async t => {
  const root = await mkdtemp(join(tmpdir(), 'bellteam-real-h1-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const base = join(root, 'state'), home = join(root, 'home'), codex = join(home, '.codex'), temp = join(root, 'tmp')
  for (const path of [base, home, codex, temp, join(codex, 'sessions')]) await mkdir(path, { mode: 0o700 })
  const target = { session_id: 'offline', launch_id: 'a'.repeat(32) }, id = target.launch_id
  const vendor = '11111111-2222-4333-8444-555555555555', file = join(codex, 'sessions/root.jsonl')
  const retained = Buffer.from('retained synthetic rollout\n');await writeFile(file, retained, { mode: 0o600 })
  const st = await stat(file), socket = join(temp, 'claude-tmux-sockets/claude.sock')
  const recipe = { schema: 'aiterm.agent-resume.v1', launch_id: id, kind: 'codex', vendor_session_id: vendor,
    executable: '/synthetic/codex-never-run', cwd: home, configuration_root: codex, model: 'sol', reasoning_effort: 'high', fast: false, environment: {} }
  const proof = { schema: 'aiterm.codex-resume-proof.v1', launch_id: id, session_id: vendor, file,
    device: String(st.dev), inode: String(st.ino), cursor: st.size, prefix_bytes: st.size, prefix_sha256: resumeDigest(retained), last_turn_id: 'synthetic' }
  const agents = join(base, `aiterm-mcp-${process.getuid()}`, 'agents')
  await mkdir(agents, { recursive: true, mode: 0o700 })
  const meta = { kind: 'codex', aiterm_session: target.session_id, launch_id: id,
    event_file: join(agents, `offline.${id}.events.jsonl`), created_at: '2026-11-02T15:00:00.000Z', cwd: home,
    vendor_session_id: vendor, initial_prompt: 'none', agent_executable: recipe.executable, hook_route: 'shared_codex_home',
    completion_route: 'codex_transcript', agent_role: 'subagent', parent_session_id: 'host-root', delegation_depth: 1,
    lineage: 'host-root>codex:offline', delegation_allowed: true,
    node_platform: 'linux', codex_home: codex, fast: false, model: 'sol' }
  const life = { schema: 'aiterm.agent-lifecycle.v1', launch_id: id, state: 'hibernated', socket, at: meta.created_at,
    anchor: 'synthetic', native_id: '$1', pane: { pid: 10, process_group_id: 10, started_identity: 'linux:1', argv_digest: '2'.repeat(64) },
    recipe_digest: resumeDigest(Buffer.from(JSON.stringify(recipe))), resume_proof_digest: resumeDigest(Buffer.from(JSON.stringify(proof))) }
  const { resumeCheckpointRecord, resumeCheckpointRecordPath } = await import(pathToFileURL(join(dist, 'resume-checkpoint.js')))
  const scope = { ...target, uid: process.getuid(), node_platform: 'linux', state_base: base, socket,
    configuration_root: codex, vendor_session_id: vendor }
  const paths = [];let metadataPath
  for (const [kind, value] of Object.entries({ generation: { schema: 'aiterm.agent-generation.v1', launch_id: id, previous_launch_id: null }, metadata: meta, recipe, proof, lifecycle: life })) {
    const bytes = Buffer.from(JSON.stringify(value, null, 2) + '\n'), record = resumeCheckpointRecord(id, kind, bytes)
    const path = resumeCheckpointRecordPath(scope, record);await writeFile(path, bytes, { mode: 0o600 });paths.push([path, bytes])
    if (kind === 'metadata') metadataPath = path
  }
  const env = { PATH: '/usr/local/bin:/usr/bin:/bin', HOME: home, CODEX_HOME: codex, AITERM_STATE_BASE: base, TMPDIR: temp }
  const spec = (operation, item) => ({ command: process.execPath, args: [join(dist, 'resume-state-cli.js'), operation,
    '--session', item.session_id, '--launch', item.launch_id, ...(operation === 'restore' ? ['--sha256', item.checkpoint_sha256] : [])], env })
  const result = await runResumePipe(spec('checkpoint', target), 'checkpoint', target)
  const privateRoot = join(root, 'private'), item = await saveResumeCheckpoint(privateRoot, 'supply', target, result)
  const old = join(root, 'old-state');await rename(base, old);await mkdir(base, { mode: 0o700 })
  assert.notEqual((await stat(base)).ino, (await stat(old)).ino)
  const plan = { schema: 'bellteam.resume-generation.v1', generation: 'supply', source_container: 'c'.repeat(64),
    source_image: 'sha256:' + 'd'.repeat(64), state_volume: 'new-volume', targets: [item] }
  await publishResumeFile(join(privateRoot, 'supply'), 'generation.json', Buffer.from(JSON.stringify(plan) + '\n'))
  let calls = 0
  const restore = async (selected, input) => { calls++;return runResumePipe(spec('restore', selected), 'restore', selected, { input }) }
  await adoptResumeGeneration(privateRoot, 'supply', 'new-volume', restore)
  for (const [path, bytes] of paths) {
    assert.deepEqual(await readFile(path), bytes)
    assert.deepEqual(await readFile(path.replace(base, old)), bytes)
  }
  const again = await restore(item, result.bundle);assert.equal(again.receipt.outcome, 'already_restored')
  await adoptResumeGeneration(privateRoot, 'supply', 'new-volume', restore)
  assert.equal(calls, 2)
  await assert.rejects(runResumePipe(spec('restore', { ...item, checkpoint_sha256: '0'.repeat(64) }), 'restore', item, { input: result.bundle }), { code: 'RESUME_PROCESS_FAILED' })
  await assert.rejects(stat(socket), { code: 'ENOENT' })
  assert.ok(metadataPath)
  const invalid = JSON.parse(await readFile(metadataPath));delete invalid.completion_route
  await writeFile(metadataPath, JSON.stringify(invalid) + '\n', { mode: 0o600 })
  await assert.rejects(runResumePipe(spec('checkpoint', target), 'checkpoint', target), { code: 'RESUME_PROCESS_FAILED' })
})
