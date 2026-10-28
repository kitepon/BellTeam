#!/usr/bin/env node
import { dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { constants, openSync, closeSync, fstatSync, lstatSync, readFileSync, readSync } from 'node:fs'

// The fixed C entry owns FD 3; a number in the environment is not a lock receipt.
if (process.getuid?.() === 1001) {
  let parent
  try {
    const control = '/run/bellteam-maintenance'
    const privateMetadata = (value, directory = false) => {
      if (!(directory ? value.isDirectory() : value.isFile()) || value.uid !== 0 || value.gid !== 1001
        || (value.mode & 0o7777) !== (directory ? 0o750 : 0o640) || !directory && value.nlink > 1)
        throw new Error('metadata')
    }
    const same = (a, b) => a.dev === b.dev && a.ino === b.ino
    const bounded = fd => {
      const size = fstatSync(fd).size
      if (size < 1 || size > 65536) throw new Error('size')
      const raw = Buffer.alloc(size + 1)
      let used = 0, count
      while ((count = readSync(fd, raw, used, raw.length - used, used)) > 0) used += count
      if (used !== size) throw new Error('changed')
      return raw.subarray(0, used).toString('utf8')
    }
    parent = openSync(control, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW)
    privateMetadata(fstatSync(parent), true)
    const held = fstatSync(3), linked = lstatSync(`/proc/self/fd/${parent}/sec014.lock`)
    privateMetadata(held)
    privateMetadata(linked)
    if (!same(held, linked)) throw new Error('inode')
    const info = readFileSync('/proc/self/fdinfo/3', 'utf8')
    if ((parseInt(info.match(/^flags:\s+([0-7]+)$/m)?.[1] ?? '3', 8) & 3) !== 0
      || !new RegExp(`^lock:\\s+\\d+:\\s+FLOCK\\s+ADVISORY\\s+READ\\s+${process.pid}\\s`, 'm').test(info))
      throw new Error('lock')
    const direction = bounded(3)
    if (!['to-server\n', 'to-legacy\n'].includes(direction)) throw new Error('direction')
    const journal = openSync(`/proc/self/fd/${parent}/transaction-${direction.trim()}.json`, constants.O_RDONLY | constants.O_NOFOLLOW)
    let value
    try {
      // Atomic replace can unlink this opened journal; its complete snapshot remains valid under SH.
      privateMetadata(fstatSync(journal))
      value = JSON.parse(bounded(journal))
    } finally { closeSync(journal) }
    const phases = ['writers_stopped', 'prepared', 'migrated', 'binds_confirmed', 'started', 'verified']
    const hex = (value, pattern) => typeof value === 'string' && pattern.test(value)
    const selected = value?.admission
    const token = process.env.BELLTEAM_NORMAL_ADMISSION_TOKEN
    if (value?.schema !== 'bellteam.sec014.host-transaction.v1' || value.direction !== direction.trim()
      || !Array.isArray(value.phases) || ![4, 5, 6].includes(value.phases.length)
      || value.phases.some((phase, index) => phase !== phases[index])
      || value.status !== (value.phases.length === 6 ? 'completed' : 'incomplete')
      || !Number.isSafeInteger(value.actorPid) || value.actorPid < 1
      || !Number.isSafeInteger(value.actorStartTicks) || value.actorStartTicks < 1
      || !selected || Object.keys(selected).sort().join(',') !== 'containerId,image,token'
      || !hex(selected.containerId, /^[a-f0-9]{64}$/u) || !hex(selected.image, /^sha256:[a-f0-9]{64}$/u)
      || !hex(token, /^[a-f0-9]{64}$/u) || selected.token !== token
      || bounded(3) !== direction || !same(fstatSync(3), lstatSync(`/proc/self/fd/${parent}/sec014.lock`))
      || !same(fstatSync(parent), lstatSync(control))) throw new Error('selection')
    privateMetadata(fstatSync(3))
    privateMetadata(lstatSync(`/proc/self/fd/${parent}/sec014.lock`))
    privateMetadata(lstatSync(control), true)
    delete process.env.BELLTEAM_NORMAL_ADMISSION_TOKEN
  } catch {
    process.stderr.write('BELLTEAM_NORMAL_ADMISSION\n')
    process.exit(126)
  } finally { if (parent !== undefined) closeSync(parent) }
}

const bootstrap = await import('./bootstrap.mjs')
const { createApplicationRuntime } = await import('./application-runtime.mjs')
const { waitForShutdown } = await import('./lifecycle.mjs')

const runtime = await createApplicationRuntime({
  root: process.env.BELLTEAM_ROOT ?? '/srv/bellteam',
  appRoot: dirname(dirname(fileURLToPath(import.meta.url))),
  bootstrap,
})
await runtime.start()
process.stderr.write('BellTeam ready\n')
await waitForShutdown()
await runtime.close()
