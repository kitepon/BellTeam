import assert from 'node:assert/strict'
import fs from 'node:fs'
import { syncBuiltinESMExports } from 'node:module'
import test from 'node:test'
import { verifyUsageLocks } from '../src/usage-locks.mjs'
import { verifyDiagnosticsLocks } from '../src/diagnostics-locks.mjs'

test('module verifier binds both descriptors and kernel locks to this IPC process', () => {
  const originalFs = { fstatSync: fs.fstatSync, lstatSync: fs.lstatSync, readFileSync: fs.readFileSync }
  const keys = ['getuid', 'geteuid', 'getgid', 'getegid', 'connected']
  const originalProcess = keys.map(key => [key, Object.getOwnPropertyDescriptor(process, key)])
  const directory = { dev: 1, ino: 2, uid: 0, gid: 1001, mode: 0o40750, isDirectory: () => true }
  const writer = { dev: 1, ino: 3, uid: 1001, gid: 1001, mode: 0o100600, nlink: 1, isFile: () => true }
  let pid = process.pid, linked = writer, readLock = 'READ'
  try {
    for (const key of keys) Object.defineProperty(process, key, { configurable: true, value: key === 'connected' ? true : () => 1001 })
    fs.fstatSync = fd => fd === 4 ? directory : writer
    fs.lstatSync = path => path === '/run/bellteam-maintenance' ? directory : linked
    fs.readFileSync = path => `lock:\t1: FLOCK ADVISORY ${path.endsWith('/4') ? readLock : 'WRITE'} ${pid} 00:00:1 0 EOF\n`
    syncBuiltinESMExports()
    verifyUsageLocks(); verifyDiagnosticsLocks()
    pid++
    assert.throws(verifyUsageLocks, /MODULE_LOCK_INVALID/)
    pid = process.pid; readLock = 'WRITE'
    assert.throws(verifyDiagnosticsLocks, /MODULE_LOCK_INVALID/)
    readLock = 'READ'; linked = { ...writer, ino: 4 }
    assert.throws(verifyUsageLocks, /MODULE_LOCK_INVALID/)
    linked = writer; writer.nlink = 2
    assert.throws(verifyUsageLocks, /MODULE_LOCK_INVALID/)
    writer.nlink = 1; writer.mode = 0o100660
    assert.throws(verifyDiagnosticsLocks, /MODULE_LOCK_INVALID/)
    writer.mode = 0o100600; writer.uid = 1000
    assert.throws(verifyUsageLocks, /MODULE_LOCK_INVALID/)
  } finally {
    Object.assign(fs, originalFs); syncBuiltinESMExports()
    for (const [key, descriptor] of originalProcess) {
      if (descriptor) Object.defineProperty(process, key, descriptor)
      else delete process[key]
    }
  }
})
