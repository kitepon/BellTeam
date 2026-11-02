import { basename, isAbsolute } from 'node:path'
import { pathToFileURL } from 'node:url'
import { text } from 'node:stream/consumers'
import { stateWriterPlan } from './server-state-writers.mjs'
import { checkResumeTarget } from './resume-pipe.mjs'
import { RESUME_STATE_BASE } from './resume-policy.mjs'

export function planResumeInstall(normal, previous, runtime, targets, saved) {
  const current = stateWriterPlan(normal), old = previous ? stateWriterPlan(previous) : null
  if (!current.resumeVolumes) throw new Error('RESUME_STATE_UNAVAILABLE')
  const state_volume = current.resumeVolumes[0], source_volume = old?.resumeVolumes?.[0] ?? ''
  if (state_volume === source_volume) throw new Error('RESUME_BACKING_CONFLICT')
  const generation = basename(saved), seen = new Set()
  if (!/^\.bellteam-compose\.[A-Za-z0-9]+$/.test(generation) || targets !== null
    && (!Array.isArray(targets) || !targets.length || !source_volume)) throw new Error('RESUME_STATE_UNAVAILABLE')
  for (const target of targets ?? []) {
    checkResumeTarget(target)
    if (Object.keys(target).sort().join(',') !== 'launch_id,session_id' || seen.has(target.session_id))
      throw new Error('RESUME_TARGET_INVALID')
    seen.add(target.session_id)
  }
  const source = Array.isArray(runtime) ? runtime[0] : runtime
  if (targets && (!/^[a-f0-9]{64}$/.test(source?.Id ?? '') || !/^sha256:[a-f0-9]{64}$/.test(source?.Image ?? '')))
    throw new Error('RESUME_SOURCE_UNCONFIRMED')
  const home = previous?.services.bellteam.volumes.find(mount => mount.target === '/home/bell')?.source ?? ''
  if (targets && (!isAbsolute(home) || /[\r\n\0]/.test(home) || old.roots[1] !== current.roots[1])) throw new Error('RESUME_SOURCE_UNCONFIRMED')
  const service = normal.services.bellteam
  service.environment.BELLTEAM_AITERM_STATE_VOLUME = state_volume
  if (targets) service.environment.BELLTEAM_RESUME_GENERATION = generation
  else delete service.environment.BELLTEAM_RESUME_GENERATION
  return { plan: { schema: 'bellteam.resume-generation.v1', generation,
    source_container: source?.Id ?? '', source_image: source?.Image ?? '', state_volume,
    source_volume, home, targets: targets ?? [] }, normal }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const [normal, old, runtime, targets] = JSON.parse((await text(process.stdin)).replaceAll('$$', '$'))
    const result = planResumeInstall(normal, old, runtime, targets, process.argv[2])
    console.log(JSON.stringify(result.plan))
    console.log(JSON.stringify(result.normal, (_key, value) => typeof value === 'string' ? value.replaceAll('$', () => '$$') : value))
  } catch { process.stderr.write('RESUME_INSTALL_PLAN_INVALID\n');process.exitCode = 1 }
}
