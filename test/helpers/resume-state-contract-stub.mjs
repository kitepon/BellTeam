#!/usr/bin/env node
// H1 contract stub for aiterm-mcp's public resume-state CLI (aiterm-resume-state): one fixture target, fixed bytes, no Aiterm state read.
import { createHash } from 'node:crypto'
import { realpathSync, readFileSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

export const STUB_CHECKPOINT = Buffer.from('h1 synthetic checkpoint\n')
const target = { session_id: 'offline', launch_id: 'a'.repeat(32) }
const digest = bytes => createHash('sha256').update(bytes).digest('hex')
const receipt = (operation, bytes, outcome) => JSON.stringify({ schema: 'aiterm.resume-state-result.v1', operation, ...target, checkpoint_sha256: digest(bytes), outcome }) + '\n'

export function main(args = process.argv.slice(2), home = process.env.HOME) {
  try {
    const [operation, ...rest] = args, fields = {}
    for (let i = 0; i < rest.length; i += 2) {
      const k = rest[i], v = rest[i + 1]
      if (!['--session', '--launch', ...(operation === 'restore' ? ['--sha256'] : [])].includes(k) || v === undefined || fields[k] !== undefined) throw Error()
      fields[k] = v
    }
    if (!['checkpoint', 'restore'].includes(operation) || fields['--session'] !== target.session_id || fields['--launch'] !== target.launch_id) throw Error()
    if (operation === 'checkpoint') {
      process.stdout.write(STUB_CHECKPOINT); process.stderr.write(receipt(operation, STUB_CHECKPOINT, 'saved'))
      return 0
    }
    const bytes = readFileSync(0), file = `${home}/h1-restored-checkpoint`
    if (digest(bytes) !== fields['--sha256']) throw Error()
    let same = false
    try { same = readFileSync(file).equals(bytes) } catch (error) { if (error.code !== 'ENOENT') throw error }
    if (!same) writeFileSync(file, bytes, { mode: 0o600 })
    process.stdout.write(receipt(operation, bytes, same ? 'already_restored' : 'restored'))
    return 0
  } catch {
    process.stderr.write('aiterm: RESUME_STATE_UNCONFIRMED\n')
    return 2
  }
}

// Also runs when reached through the bin symlink or when mounted over the exported file.
if (process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))) process.exitCode = main()
