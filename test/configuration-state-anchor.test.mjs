import assert from 'node:assert/strict'
import fs from 'node:fs'
import test from 'node:test'
import { acquireConfigurationStateAnchor } from '../src/configuration-state-anchor.mjs'

const statePath = '/srv/bellteam/state', controlPath = '/run/bellteam-maintenance'

function fixture(t) {
  const stat = (uid, gid, mode, ino) => ({ uid, gid, mode, dev: 21, ino, isDirectory: () => true })
  const paths = new Map([
    ['/', stat(0, 0, 0o755, 1)], ['/srv', stat(0, 0, 0o755, 2)], ['/run', stat(0, 0, 0o755, 3)],
    ['/srv/bellteam', stat(1000, 1000, 0o711, 4)], [controlPath, stat(0, 1001, 0o750, 5)],
    [statePath, stat(1001, 1001, 0o711, 6)], [`${controlPath}/state`, stat(1001, 1001, 0o711, 6)],
  ])
  const fds = new Map([[3, { ...paths.get(controlPath) }], [4, { ...paths.get(statePath) }]])
  const files = new Map([
    ['/proc/self/fdinfo/3', `flags:\t0100000\nlock:\t1: FLOCK ADVISORY READ ${process.pid} 00:15:5 0 EOF\n`],
    ['/proc/self/fdinfo/4', `flags:\t0100000\nlock:\t1: FLOCK ADVISORY WRITE ${process.pid} 00:15:6 0 EOF\n`],
    ['/proc/self/mountinfo', `20 10 0:21 / ${controlPath} ro,relatime - ext4 /dev/fixture rw\n21 10 0:21 /state ${statePath} rw,relatime - ext4 /dev/fixture rw\n`],
  ])
  const redirects = new Map()
  for (const method of ['getuid', 'geteuid', 'getgid', 'getegid']) t.mock.method(process, method, () => 1001)
  t.mock.method(fs, 'lstatSync', path => {
    const value = paths.get(path)
    if (!value) throw Object.assign(new Error('fixture missing'), { code: 'ENOENT' })
    return value
  })
  t.mock.method(fs, 'realpathSync', path => redirects.get(path) ?? path)
  t.mock.method(fs, 'fstatSync', fd => fds.get(fd))
  t.mock.method(fs, 'readFileSync', path => {
    if (!files.has(path)) throw new Error('fixture unreadable')
    return files.get(path)
  })
  return { paths, fds, files, redirects }
}

test('managed UID1001 state accepts its real deployment UID1000/0711 parent only with locks and mount identity', t => {
  fixture(t)
  const anchor = acquireConfigurationStateAnchor('/srv/bellteam')
  assert.deepEqual(anchor, { path: statePath, uid: 1001, dev: 21, ino: 6 })
  assert.equal(Object.isFrozen(anchor), true)
})

test('a nonproduction root receives no ancestor exemption and performs no runtime filesystem reads', t => {
  t.mock.method(fs, 'lstatSync', () => assert.fail('unexpected filesystem access'))
  assert.equal(acquireConfigurationStateAnchor('/tmp/isolated-state'), undefined)
  assert.equal(acquireConfigurationStateAnchor('/srv/bellteam/'), undefined)
})

const rejections = {
  'wrong real UID': (f, t) => t.mock.method(process, 'getuid', () => 1000),
  'wrong effective UID': (f, t) => t.mock.method(process, 'geteuid', () => 0),
  'wrong effective GID': (f, t) => t.mock.method(process, 'getegid', () => 1000),
  'wrong ancestor owner': f => { f.paths.get('/srv').uid = 1000 },
  'writable ancestor': f => { f.paths.get('/run').mode = 0o777 },
  'wrong parent mode': f => { f.paths.get('/srv/bellteam').mode = 0o755 },
  'wrong control owner': f => { f.paths.get(controlPath).uid = 1001 },
  'wrong state owner': f => { f.paths.get(statePath).uid = 1000 },
  'group writable state': f => { f.paths.get(statePath).mode = 0o731 },
  'other writable state': f => { f.paths.get(statePath).mode = 0o713 },
  'symlink ancestor': f => { f.paths.get('/srv/bellteam').isDirectory = () => false },
  'state realpath alias': f => f.redirects.set(statePath, '/other/state'),
  'control state symlink': f => f.redirects.set(`${controlPath}/state`, statePath),
  'different control state backing': f => { f.paths.get(`${controlPath}/state`).ino = 99 },
  'different held state': f => { f.fds.get(4).ino = 99 },
  'different held control': f => { f.fds.get(3).ino = 99 },
  'missing state lock': f => f.files.set('/proc/self/fdinfo/4', 'flags:\t0100000\n'),
  'wrong lock process': f => f.files.set('/proc/self/fdinfo/4', 'flags:\t0100000\nlock:\t1: FLOCK ADVISORY WRITE 0 00:15:6 0 EOF\n'),
  'wrong control lock mode': f => f.files.set('/proc/self/fdinfo/3', f.files.get('/proc/self/fdinfo/3').replace('READ', 'WRITE')),
  'writable inherited FD': f => f.files.set('/proc/self/fdinfo/4', f.files.get('/proc/self/fdinfo/4').replace('0100000', '0100002')),
  'missing mount': f => f.files.set('/proc/self/mountinfo', ''),
  'read-only state mount': f => f.files.set('/proc/self/mountinfo', f.files.get('/proc/self/mountinfo').replace(`${statePath} rw,`, `${statePath} ro,`)),
  'writable control mount': f => f.files.set('/proc/self/mountinfo', f.files.get('/proc/self/mountinfo').replace(`${controlPath} ro,`, `${controlPath} rw,`)),
  'ambiguous mountpoint': f => f.files.set('/proc/self/mountinfo', f.files.get('/proc/self/mountinfo').repeat(2)),
  'unreadable kernel metadata': f => f.files.delete('/proc/self/mountinfo'),
  'unsafe inode number': f => { for (const st of [f.paths.get(statePath), f.paths.get(`${controlPath}/state`), f.fds.get(4)]) st.ino = Number.MAX_SAFE_INTEGER + 1 },
}

for (const [name, mutate] of Object.entries(rejections)) test(`rejects ${name} before supplying an anchor`, t => {
  const f = fixture(t); mutate(f, t)
  assert.throws(() => acquireConfigurationStateAnchor('/srv/bellteam'), error => error.code === 'CONFIGURATION_STORAGE_INVALID'
    && error.status === 503 && error.effect === 'not_issued' && error.message === 'CONFIGURATION_STORAGE_INVALID')
})

test('rechecks the mounted state identity before publishing the anchor', t => {
  const f = fixture(t), original = fs.lstatSync
  let reads = 0
  t.mock.method(fs, 'lstatSync', path => path === statePath && ++reads === 2 ? { ...f.paths.get(path), ino: 99 } : original(path))
  assert.throws(() => acquireConfigurationStateAnchor('/srv/bellteam'), /CONFIGURATION_STORAGE_INVALID/)
})
