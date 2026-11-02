import { join } from 'node:path'
import { seatCommandSpec } from './seat-command.mjs'
import { adoptResumeGeneration } from './resume-boot.mjs'
import { runResumePipe } from './resume-pipe.mjs'
import { fixedResumeBase } from './resume-policy.mjs'
import { AITERM_DIST } from './aiterm-hooks.mjs'

export async function adoptRuntimeResume() {
  const generation = process.env.BELLTEAM_RESUME_GENERATION
  if (!generation) return
  if (process.getuid() !== 1001 || process.geteuid() !== 1001 || process.getgid() !== 1001)
    throw new Error('RESUME_STARTUP_ADMISSION')
  if (!fixedResumeBase()) throw new Error('RESUME_STATE_BASE_CONFLICT')
  const root = process.env.BELLTEAM_ROOT ?? '/srv/bellteam'
  const controller = new AbortController(), stop = () => controller.abort()
  for (const signal of ['SIGTERM', 'SIGINT', 'SIGHUP']) process.on(signal, stop)
  try { await adoptResumeGeneration(join(root, 'state/resume-checkpoints'), generation,
    process.env.BELLTEAM_AITERM_STATE_VOLUME, async (target, input) => {
      const spec = seatCommandSpec(process.execPath, [join(AITERM_DIST, 'resume-state-cli.js'), 'restore',
        '--session', target.session_id, '--launch', target.launch_id, '--sha256', target.checkpoint_sha256],
      { project: root, environment: 'base' })
      return runResumePipe(spec, 'restore', target, { input, signal: controller.signal })
    })
    if (controller.signal.aborted) throw new Error('ABORT_ERR')
  } finally {
    for (const signal of ['SIGTERM', 'SIGINT', 'SIGHUP']) process.removeListener(signal, stop)
  }
}
