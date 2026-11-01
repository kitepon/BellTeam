#!/usr/bin/env node
import { dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { constants, openSync, closeSync, fstatSync, lstatSync, readFileSync } from 'node:fs'

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
    parent = openSync(control, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW)
    privateMetadata(fstatSync(parent), true)
    const held = fstatSync(3), linked = lstatSync(control)
    privateMetadata(held, true)
    if (!same(held, linked)) throw new Error('inode')
    const info = readFileSync('/proc/self/fdinfo/3', 'utf8')
    if ((parseInt(info.match(/^flags:\s+([0-7]+)$/m)?.[1] ?? '3', 8) & 3) !== 0
      || !new RegExp(`^lock:\\s+\\d+:\\s+FLOCK\\s+ADVISORY\\s+READ\\s+${process.pid}\\s`, 'm').test(info))
      throw new Error('lock')
    const state = fstatSync(4), stateLinked = lstatSync('/srv/bellteam/state')
    if (!state.isDirectory() || state.uid !== 1001 || state.gid !== 1001 || !same(state, stateLinked)
      || !new RegExp(`^lock:\\s+\\d+:\\s+FLOCK\\s+ADVISORY\\s+WRITE\\s+${process.pid}\\s`, 'm')
        .test(readFileSync('/proc/self/fdinfo/4', 'utf8'))) throw new Error('state lock')
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
