import { receiveResumeInput } from './resume-storage.mjs'
import { RESUME_BUNDLE_BYTES, RESUME_RECEIPT_BYTES } from './resume-pipe.mjs'

// Runs as the existing private-state owner inside the frozen maintenance model.
try {
  if (process.getuid() !== 1001 || process.geteuid() !== 1001) throw Error()
  const [mode, generation, session_id, launch_id] = process.argv.slice(2)
  if (mode === 'stage') process.stdout.write('READY\n')
  const max = mode === 'stage' ? RESUME_BUNDLE_BYTES : mode === 'finish' ? RESUME_RECEIPT_BYTES : 64 * 1024
  let size = 0;const chunks = []
  for await (const chunk of process.stdin) {
    size += chunk.length;if (size > max) throw Error();chunks.push(chunk)
  }
  await receiveResumeInput('/srv/bellteam-private/state/resume-checkpoints', mode, generation,
    { session_id, launch_id }, Buffer.concat(chunks))
} catch { process.stderr.write('RESUME_PRIVATE_STORE_FAILED\n');process.exitCode = 1 }
