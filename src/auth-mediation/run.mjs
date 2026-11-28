// The run channel (README F22): the item fixes the command and holds the secrets; the caller only pipes bytes in and out. The secrets live in this process, in the run's
// environment, in 0600 files on a tmpfs folder that is deleted at the end, and in a per-run ssh-agent; never in argv and never in the answer.
import { spawn as nodeSpawn } from 'node:child_process'
import { connect as netConnect } from 'node:net'
import { existsSync, readFileSync } from 'node:fs'
import { chmod, mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

export const RUN_ROOT = '/run/bellteam-server/auth-run'
export const STATE_ROOT = '/srv/bellteam/state/auth-mediation/run-state' // persistent, owned by the child
export const SOCKET_ROOT = '/srv/bellteam/shared/tools/auth-mediation/run-sockets' // shared with the host: a service's unix socket here is reachable from main-server (relay.py makes it 1777)
const HEARTBEAT_MS = 15000, MAX_RUNS = 4, STDERR_MAX = 65536, DEFAULT_SECONDS = 3600, MAX_SECONDS = 86400, DEFAULT_IN = 4 * 2 ** 30
const PATH_ENV = '/srv/bellteam/shared/tools/age/bin:/srv/bellteam/shared/tools/cloudflared/bin:/usr/local/bin:/usr/bin:/bin'
const refuse = message => Object.assign(new Error(message), { code: 'RUN_REFUSED' })
const live = new Map() // run id -> { item, kill, done }

export const stopRuns = item => { for (const run of live.values()) if (!item || run.item === item) run.kill() }
// The child's own end (disconnect, SIGTERM, a row exchange): every command dies and its folder is removed before the process goes.
export const stopAllRuns = async () => { const all = [...live.values()]; stopRuns(); await Promise.allSettled(all.map(run => run.done)) }

// A run folder records the process group of its command and its agent (pid + start time, so a reused pid is never hit). At child start every folder left by a child that was
// killed hard is swept: the leftover command and agent die and the secret files go.
const startOf = pid => { try { return readFileSync(`/proc/${pid}/stat`, 'utf8').split(') ')[1].split(' ')[19] } catch { return null } }
export async function sweepStaleRuns(root = RUN_ROOT) {
  let names = []; try { names = await readdir(root) } catch { return 0 }
  for (const name of names.filter(n => n.startsWith('run-'))) {
    try { for (const p of JSON.parse(readFileSync(join(root, name, 'pids.json'), 'utf8')).procs) if (startOf(p.pid) === p.start) { try { process.kill(p.group ? -p.pid : p.pid, 'SIGKILL') } catch {} } } catch {}
    await rm(join(root, name), { recursive: true, force: true }).catch(() => {})
  }
  return names.length
}

// Pure: the item's fields -> the plan of one run, or a refusal. Secrets are every run_env_*, run_file_*, run_ssh_key and run_stdin_prefix value.
export function planRun(fields) {
  let argv
  try { argv = JSON.parse(fields.run_argv ?? '') } catch { throw refuse('The key item has no usable command.') }
  if (!Array.isArray(argv) || argv.length < 1 || argv.length > 64 || !argv.every(a => typeof a === 'string' && a.length >= 1 && a.length <= 4096 && !a.includes('\0')) || !argv[0].startsWith('/') && !/^[A-Za-z0-9._-]+$/u.test(argv[0])) throw refuse('The key item has no usable command.')
  const env = {}, files = {}, secrets = []
  for (const [label, value] of Object.entries(fields)) {
    let m
    if ((m = /^run_env_([A-Z][A-Z0-9_]{0,63})$/u.exec(label))) { env[m[1]] = value; secrets.push(value) }
    else if ((m = /^run_file_([A-Z][A-Z0-9_]{0,63})$/u.exec(label))) { files[m[1]] = value; secrets.push(value) }
  }
  if (fields.run_ssh_key) secrets.push(fields.run_ssh_key)
  if (fields.run_stdin_prefix) secrets.push(fields.run_stdin_prefix)
  for (const secret of secrets) if (secret.length >= 6 && argv.some(a => a.includes(secret))) throw refuse('The key item puts a secret in the command line.') // argv is visible to every process
  const seconds = Number(fields.run_max_seconds ?? DEFAULT_SECONDS), bytesIn = Number(fields.run_max_bytes_in ?? DEFAULT_IN)
  if (!Number.isFinite(seconds) || seconds < 0 || seconds > MAX_SECONDS || !Number.isFinite(bytesIn) || bytesIn < 0) throw refuse('The key item has no usable limits.')
  const name = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/u
  if ((fields.run_state_dir !== undefined && fields.run_state_dir !== '1') || (fields.run_socket_dir !== undefined && fields.run_socket_dir !== '1')) throw refuse('The key item has no usable folders.')
  return { stateDir: fields.run_state_dir === '1', socketDir: fields.run_socket_dir === '1', folderName: name, argv, env, files, sshKey: fields.run_ssh_key, prefix: fields.run_stdin_prefix, stdin: fields.run_stdin !== '0', seconds: seconds || 0, bytesIn, secrets: secrets.filter(s => s.length >= 6), parallel: fields.run_parallel === '1' }
}

const frame = (tag, data) => { const head = Buffer.alloc(5); head[0] = tag; head.writeUInt32BE(data.length, 1); return Buffer.concat([head, data]) }

// Starts the run and returns once the process is spawned and joined to the caller's stream; the end (exit code, counts) goes to onEnd.
export async function startRun(plan, { item, stream, onEnd, spawn = nodeSpawn, connect = netConnect, root = RUN_ROOT, stateRoot = STATE_ROOT, socketRoot = SOCKET_ROOT }) {
  if (live.size >= MAX_RUNS) throw refuse('Too many runs are in progress.')
  if (!plan.parallel && [...live.values()].some(run => run.item === item)) throw refuse('This key is already in use.')
  await mkdir(root, { recursive: true, mode: 0o700 })
  const dir = await mkdtemp(join(root, 'run-')), id = dir.slice(-12), agents = []
  const record = async group => writeFile(join(dir, 'pids.json'), JSON.stringify({ procs: [...agents.map(a => ({ pid: a.pid, start: startOf(a.pid), group: false })), ...(group ? [{ pid: group, start: startOf(group), group: true }] : [])] }), { mode: 0o600 })
  let finish; const done = new Promise(resolve => { finish = resolve })
  const cleanup = async () => { for (const a of agents) try { a.kill('SIGKILL') } catch {}; await rm(dir, { recursive: true, force: true }).catch(() => {}) }
  let socket
  try {
    const env = { PATH: PATH_ENV, HOME: dir, LANG: 'C.UTF-8', ...plan.env }
    // Item-asked folders, named after the item (never after the caller): a persistent state folder (0700) and a socket folder (0755) the host can reach.
    const folder = item.replace(/^run /u, '')
    if (plan.stateDir || plan.socketDir) { if (!plan.folderName.test(folder)) throw refuse('The key item has no usable folders.') }
    if (plan.stateDir) { env.STATE_DIR = join(stateRoot, folder); await mkdir(env.STATE_DIR, { recursive: true, mode: 0o700 }) }
    if (plan.socketDir) { env.SOCKET_DIR = join(socketRoot, folder); await mkdir(env.SOCKET_DIR, { recursive: true, mode: 0o755 }); await chmod(env.SOCKET_DIR, 0o755) }
    for (const [name, value] of Object.entries(plan.files)) { const path = join(dir, name.toLowerCase()); await writeFile(path, value.endsWith('\n') ? value : value + '\n', { mode: 0o600 }); env[name] = path }
    if (plan.sshKey) {
      const sock = join(dir, 'agent.sock'), agent = spawn('ssh-agent', ['-D', '-a', sock], { stdio: 'ignore', env: { PATH: PATH_ENV } }); agents.push(agent)
      for (let i = 0; i < 60 && !existsSync(sock); i++) await new Promise(r => setTimeout(r, 50))
      await new Promise((resolve, reject) => { const add = spawn('ssh-add', ['-q', '-'], { stdio: ['pipe', 'ignore', 'ignore'], env: { PATH: PATH_ENV, SSH_AUTH_SOCK: sock } }); add.on('exit', code => code === 0 ? resolve() : reject(refuse('The key item has no usable ssh key.'))); add.on('error', () => reject(refuse('The key item has no usable ssh key.'))); add.stdin.end(plan.sshKey.endsWith('\n') ? plan.sshKey : plan.sshKey + '\n') })
      env.SSH_AUTH_SOCK = sock
      await record(null)
    }
    socket = await new Promise((resolve, reject) => { const s = connect({ path: stream, allowHalfOpen: true }); s.once('connect', () => resolve(s)); s.once('error', () => reject(refuse('The caller is gone.'))) })
    const child = spawn(plan.argv[0], plan.argv.slice(1), { env, cwd: dir, detached: true, stdio: [plan.stdin || plan.prefix ? 'pipe' : 'ignore', 'pipe', 'pipe'] }) // own process group: a kill reaches what the command started
    await new Promise((resolve, reject) => { child.once('spawn', resolve); child.once('error', () => reject(refuse('The command cannot start.'))) })
    const started = Date.now(); let bytesIn = 0, bytesOut = 0, ended = false, killed = null
    const kill = reason => {
      if (ended) return
      killed ??= reason ?? 'stopped'
      try { child.stdout?.resume(); child.stderr?.resume() } catch {}
      try { process.kill(-child.pid, 'SIGKILL') } catch { try { child.kill('SIGKILL') } catch {} }
    }
    live.set(id, { item, kill, done }); await record(child.pid)
    // A heartbeat frame (tag 4, empty) every 15 s: when the caller is gone, the relay's write fails and it closes the stream, so a silent long-lived command (cloudflared) still ends with its caller.
    const beat = setInterval(() => { try { socket.write(frame(4, Buffer.alloc(0))) } catch {} }, HEARTBEAT_MS)
    const timer = plan.seconds ? setTimeout(() => kill('time'), plan.seconds * 1000) : null
    if (child.stdin) {
      child.stdin.on('error', () => {})
      if (plan.prefix) child.stdin.write(plan.prefix.endsWith('\n') ? plan.prefix : plan.prefix + '\n')
      if (plan.stdin) {
        socket.on('data', chunk => { bytesIn += chunk.length; if (bytesIn > plan.bytesIn) return kill('size'); if (!child.stdin.write(chunk)) { socket.pause(); child.stdin.once('drain', () => socket.resume()) } })
        socket.on('end', () => child.stdin.end())
      } else child.stdin.end()
    }
    child.stdout.on('data', chunk => {
      bytesOut += chunk.length
      if (!socket.destroyed && !socket.write(frame(1, chunk))) {
        child.stdout.pause()
        const resume = () => { socket.off('drain', resume); socket.off('close', resume); socket.off('error', resume); child.stdout.resume() }
        socket.once('drain', resume); socket.once('close', resume); socket.once('error', resume)
      }
    })
    let errSize = 0
    child.stderr.on('data', chunk => { if (errSize >= STDERR_MAX) return; let text = chunk.subarray(0, STDERR_MAX - errSize); errSize += text.length; text = Buffer.from(plan.secrets.reduce((out, s) => out.split(s).join('[redacted]'), text.toString('latin1')), 'latin1'); socket.write(frame(2, text)) })
    socket.on('close', () => kill('hangup')); socket.on('error', () => kill('hangup'))
    child.once('close', async (code, signal) => {
      if (ended) return; ended = true; clearTimeout(timer); clearInterval(beat); live.delete(id)
      const exit = killed ? 124 + (killed === 'hangup' ? 0 : 1) : code ?? 128, summary = { exit, reason: killed ?? (signal ? 'signal' : 'exit'), bytes_in: bytesIn, bytes_out: bytesOut, seconds: Math.round((Date.now() - started) / 1000) }
      try { socket.write(frame(3, Buffer.from(String(exit)))); socket.end() } catch {}
      await cleanup(); finish()
      onEnd?.(summary)
    })
  } catch (error) { socket?.destroy(); await cleanup(); finish(); throw error }
}
