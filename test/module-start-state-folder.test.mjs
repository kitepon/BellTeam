import test from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import { chmodSync, mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

// The fixed start of a module compiled with MODULE_STATE_ENV creates the child's own state folder (0700) and hands its path over.
// Regression: the folder was first created through the state descriptor AFTER the lock file had replaced fd 5, so the start failed with ADMISSION_FAILED (found by the first real probe of auth-mediation).
const root = fileURLToPath(new URL('..', import.meta.url))
const have = spawnSync('cc', ['--version'], { stdio: 'ignore' }).status === 0 && spawnSync('python3', ['--version'], { stdio: 'ignore' }).status === 0

test('module start with MODULE_STATE_ENV creates state/<module> 0700 and sets the env; a module without it is unchanged', { skip: !have }, () => {
  const dir = mkdtempSync(join(tmpdir(), 'module-start-'))
  try {
    for (const name of ['priv', 'state', 'app/src']) mkdirSync(join(dir, name), { recursive: true })
    chmodSync(join(dir, 'priv'), 0o750); chmodSync(join(dir, 'state'), 0o700)
    writeFileSync(join(dir, 'app/src/auth-mediation-entry.mjs'), 'echo STATE_ENV=$AUTH_MEDIATION_STATE\n')
    writeFileSync(join(dir, 'app/src/lattice-entry.mjs'), 'echo STATE_ENV=$AUTH_MEDIATION_STATE\n')
    const uid = String(process.getuid())
    const build = source => { const out = join(dir, source.split('/').at(-1) + '.bin')
      execFileSync('cc', ['-O2', '-Wall', '-Wextra', '-Werror', `-DROOT_UID=${uid}`, `-DSERVER_UID=${uid}`, `-DPRIVATE_ROOT="${dir}/priv"`, `-DSTATE_ROOT="${dir}/state"`, `-DBUILTIN_ROOT="${dir}/app"`,
        '-DNODE_BINARY="/bin/sh"', join(root, source), '-o', out]); return out }
    const run = bin => spawnSync('python3', ['-c', 'import socket,subprocess,os,sys\na,b=socket.socketpair()\nos.set_inheritable(b.fileno(),True)\np=subprocess.run([sys.argv[1],"builtin"],preexec_fn=lambda:os.dup2(b.fileno(),3),pass_fds=(3,),capture_output=True,text=True)\nprint(p.returncode);print(p.stdout,end="");print(p.stderr,end="")', bin], { encoding: 'utf8' }).stdout.split('\n')
    const auth = run(build('scripts/auth-mediation-start.c'))
    assert.equal(auth[0], '0', auth.join('|'))
    assert.equal(auth[1], `STATE_ENV=${dir}/state/auth-mediation`)
    assert.equal(statSync(join(dir, 'state/auth-mediation')).mode & 0o7777, 0o700)
    const lattice = run(build('scripts/lattice-start.c'))
    assert.equal(lattice[0], '0'); assert.equal(lattice[1], 'STATE_ENV=')
    assert.throws(() => statSync(join(dir, 'state/lattice')))
  } finally { rmSync(dir, { recursive: true, force: true }) }
})
