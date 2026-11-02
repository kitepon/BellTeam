import { join } from 'node:path'
import { readResumeFile, publishResumeFile, resumeDirectory } from './resume-storage.mjs'
import { checkResumeTarget, checkResumeReceipt, resumeDigest } from './resume-pipe.mjs'

const failure = code => Object.assign(new Error(code), { code })
const json = bytes => { try { return JSON.parse(bytes) } catch { throw failure('RESUME_GENERATION_INVALID') } }
async function optional(path, max) {
  try { return await readResumeFile(path, max) } catch (error) { if (error.code !== 'ENOENT') throw error; return null }
}

// The supervisor holds its existing startup locks throughout this call.
export async function adoptResumeGeneration(root, generation, volume, restore, { retry = false } = {}) {
  const directory = await resumeDirectory(root, generation)
  const bytes = await readResumeFile(join(directory, 'generation.json'), 64 * 1024)
  const plan = json(bytes), digest = resumeDigest(bytes)
  if (Object.keys(plan).sort().join(',') !== 'generation,schema,source_container,source_image,state_volume,targets'
    || plan.schema !== 'bellteam.resume-generation.v1' || plan.generation !== generation
    || !/^[a-f0-9]{64}$/.test(plan.source_container) || !/^sha256:[a-f0-9]{64}$/.test(plan.source_image)
    || !/^[A-Za-z0-9][A-Za-z0-9_.-]*$/.test(volume ?? '') || plan.state_volume !== volume
    || !Array.isArray(plan.targets) || !plan.targets.length) throw failure('RESUME_GENERATION_INVALID')
  const targets = new Set()
  for (const target of plan.targets) {
    checkResumeTarget(target)
    const name = `${target.session_id}.${target.launch_id}.json`
    if (Object.keys(target).sort().join(',') !== 'checkpoint_sha256,file,launch_id,session_id'
      || target.file !== name || !/^[a-f0-9]{64}$/.test(target.checkpoint_sha256) || targets.has(target.session_id))
      throw failure('RESUME_GENERATION_INVALID')
    targets.add(target.session_id)
  }
  const adopted = await optional(join(directory, 'adopted.json'), 1024)
  if (adopted) {
    const value = json(adopted)
    if (Object.keys(value).join(',') !== 'generation_sha256' || value.generation_sha256 !== digest) throw failure('RESUME_ADOPTION_CONFLICT')
    return { adopted: true, replayed: false }
  }
  const started = await optional(join(directory, 'started.json'), 1024)
  if (started) {
    const value = json(started)
    if (Object.keys(value).join(',') !== 'generation_sha256' || value.generation_sha256 !== digest || !retry) throw failure('RESUME_ADOPTION_PENDING')
  } else await publishResumeFile(directory, 'started.json', Buffer.from(JSON.stringify({ generation_sha256: digest }) + '\n'))
  for (const target of plan.targets) {
    const input = await readResumeFile(join(directory, target.file))
    if (resumeDigest(input) !== target.checkpoint_sha256) throw failure('RESUME_CHECKPOINT_CHANGED')
    const { receipt } = await restore(target, input)
    checkResumeReceipt(Buffer.from(JSON.stringify(receipt) + '\n'), 'restore', target, target.checkpoint_sha256)
  }
  await publishResumeFile(directory, 'adopted.json', Buffer.from(JSON.stringify({ generation_sha256: digest }) + '\n'))
  return { adopted: true, replayed: false }
}
