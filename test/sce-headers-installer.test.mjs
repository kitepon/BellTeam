import test from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { createBugHubSecurity } from '../src/bughub-security.mjs'

test('SCE fixed-stdin installer preserves the live generation on failed synthetic updates', () => {
  const result = spawnSync('/usr/bin/python3', ['-I', fileURLToPath(new URL('./sce-headers-installer.py', import.meta.url))], {
    encoding: 'utf8', timeout: 30_000,
  })
  assert.equal(result.status, 0, result.stderr)
  assert.doesNotMatch(result.stdout, /synthetic-generation/)
})

test('the next BugHub call reads the newly installed synthetic header/endpoint and fixes the actor', async t => {
  const root = await mkdtemp(join(tmpdir(), 'sce-call-synthetic-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const directory = join(root, 'state/bughub')
  await mkdir(directory, { recursive: true, mode: 0o711 })
  await writeFile(join(directory, 'endpoint'), 'http://synthetic.invalid/api/security/v1\n', { mode: 0o600 })
  await writeFile(join(directory, 'headers'), 'x-bughub-security-token: synthetic-first\n', { mode: 0o600 })
  const seen = []
  const call = createBugHubSecurity({ root, request: async (url, options) => {
    seen.push({ url, token: options.headers['x-bughub-security-token'], actor: options.headers['x-bughub-actor'] })
    return Response.json({ findings: [] })
  } })
  const input = { name: 'bughub_list_security_findings', args: { actor: 'bot-impostor' }, from: 'bot-synthetic-seat' }
  await call(input)
  // Synthetic test adapter only; the installed maintenance CLI has no path/UID arguments.
  const adapter = `import importlib.util,os,sys
sys.dont_write_bytecode=True
spec=importlib.util.spec_from_file_location('installer',sys.argv[1])
m=importlib.util.module_from_spec(spec)
spec.loader.exec_module(m)
m.install(sys.stdin.buffer,sys.argv[2],mode=sys.argv[3],server_uid=os.getuid(),server_gid=os.getgid(),directory_uid=os.getuid())`
  const replace = (mode, input) => {
    const result = spawnSync('/usr/bin/python3', ['-I', '-c', adapter,
      fileURLToPath(new URL('../scripts/install-sce-headers.py', import.meta.url)), directory, mode], {
      input, encoding: 'utf8', timeout: 10_000,
    })
    assert.equal(result.status, 0, result.stderr)
    assert.equal(result.stdout, '')
  }
  replace('headers', 'x-bughub-security-token: synthetic-second\n')
  await call(input)
  replace('endpoint', 'https://synthetic-next.invalid/api/security/v1\n')
  await call(input)
  assert.deepEqual(seen, [
    { url:'http://synthetic.invalid/api/security/v1/findings', token: 'synthetic-first', actor: 'bot-synthetic-seat' },
    { url:'http://synthetic.invalid/api/security/v1/findings', token: 'synthetic-second', actor: 'bot-synthetic-seat' },
    { url:'https://synthetic-next.invalid/api/security/v1/findings', token: 'synthetic-second', actor: 'bot-synthetic-seat' },
  ])
})
