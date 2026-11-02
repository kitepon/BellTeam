import { constants } from 'node:fs'
import { mkdir, open, realpath, lstat, link, unlink } from 'node:fs/promises'
import { join, isAbsolute } from 'node:path'
import { randomUUID } from 'node:crypto'
import { checkResumeTarget, checkResumeReceipt, resumeDigest, RESUME_BUNDLE_BYTES } from './resume-pipe.mjs'

const failure = code => Object.assign(new Error(code), { code })
export async function resumeDirectory(root, generation) {
  if (typeof root !== 'string' || !isAbsolute(root) || typeof generation !== 'string'
    || !/^[A-Za-z0-9._-]{1,128}$/.test(generation) || ['.', '..'].includes(generation))
    throw failure('RESUME_GENERATION_INVALID')
  for (const path of [root, join(root, generation)]) {
    await mkdir(path, { mode: 0o700, recursive: true })
    const st = await lstat(path)
    if (!st.isDirectory() || st.uid !== process.getuid() || (st.mode & 0o777) !== 0o700
      || await realpath(path) !== path) throw failure('RESUME_STORAGE_INVALID')
  }
  return join(root, generation)
}

export async function readResumeFile(path, max = RESUME_BUNDLE_BYTES) {
  const fd = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW)
  try {
    const st = await fd.stat()
    if (!st.isFile() || st.nlink !== 1 || st.uid !== process.getuid() || (st.mode & 0o777) !== 0o600 || st.size > max)
      throw failure('RESUME_STORAGE_INVALID')
    const buffer = Buffer.alloc(st.size + 1)
    let size = 0
    while (size < buffer.length) {
      const { bytesRead } = await fd.read(buffer, size, buffer.length - size, size)
      if (!bytesRead) break
      size += bytesRead
    }
    const bytes = buffer.subarray(0, size), after = await fd.stat(), linked = await lstat(path)
    if (bytes.length !== st.size || after.ino !== st.ino || after.dev !== st.dev || after.size !== st.size
      || after.mtimeMs !== st.mtimeMs || after.ctimeMs !== st.ctimeMs || linked.ino !== st.ino || linked.dev !== st.dev)
      throw failure('RESUME_STORAGE_CHANGED')
    return bytes
  } finally { await fd.close() }
}

export async function publishResumeFile(directory, name, bytes) {
  if (!/^[A-Za-z0-9._-]+$/.test(name) || ['.', '..'].includes(name) || !Buffer.isBuffer(bytes))
    throw failure('RESUME_STORAGE_INVALID')
  const target = join(directory, name), temporary = join(directory, `.${randomUUID()}.tmp`)
  const fd = await open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600)
  try { await fd.writeFile(bytes); await fd.sync() }
  catch (error) { await unlink(temporary).catch(() => {});throw error }
  finally { await fd.close() }
  // shortcut: a crash-left hardlink fails closed; repair private storage before an explicit retry.
  try { await link(temporary, target) } finally { await unlink(temporary) }
  const parent = await open(directory, constants.O_RDONLY | constants.O_DIRECTORY)
  try { await parent.sync() } finally { await parent.close() }
  return target
}

export async function saveResumeCheckpoint(root, generation, target, result) {
  checkResumeTarget(target)
  if (!result.bundle.length || result.bundle.length > RESUME_BUNDLE_BYTES) throw failure('RESUME_STREAM_INVALID')
  const digest = resumeDigest(result.bundle)
  checkResumeReceipt(Buffer.from(JSON.stringify(result.receipt) + '\n'), 'checkpoint', target, digest)
  const directory = await resumeDirectory(root, generation)
  const name = `${target.session_id}.${target.launch_id}.json`
  try { await publishResumeFile(directory, name, result.bundle) }
  catch (error) {
    if (error.code !== 'EEXIST' || !(await readResumeFile(join(directory, name))).equals(result.bundle)) throw error
  }
  return { ...target, checkpoint_sha256: digest, file: name }
}

export async function receiveResumeInput(root, mode, generation, target, input) {
  const directory = await resumeDirectory(root, generation)
  if (mode === 'stage' || mode === 'finish') {
    checkResumeTarget(target)
    const pending = `${target.session_id}.${target.launch_id}.pending`
    if (mode === 'stage') {
      if (!input.length || input.length > RESUME_BUNDLE_BYTES || input.at(-1) !== 10) throw failure('RESUME_STREAM_INVALID')
      try { await publishResumeFile(directory, pending, input) }
      catch (error) { if (error.code !== 'EEXIST' || !(await readResumeFile(join(directory, pending))).equals(input)) throw error }
    } else {
      if (input.length > 512) throw failure('RESUME_RECEIPT_INVALID')
      const bundle = await readResumeFile(join(directory, pending))
      const receipt = checkResumeReceipt(input, 'checkpoint', target, resumeDigest(bundle))
      const item = await saveResumeCheckpoint(root, generation, target, { bundle, receipt })
      const bytes = Buffer.from(JSON.stringify(item) + '\n'), name = `${target.session_id}.${target.launch_id}.receipt.json`
      try { await publishResumeFile(directory, name, bytes) }
      catch (error) { if (error.code !== 'EEXIST' || !(await readResumeFile(join(directory, name), 1024)).equals(bytes)) throw error }
      await unlink(join(directory, pending))
      const parent = await open(directory, constants.O_RDONLY | constants.O_DIRECTORY)
      try { await parent.sync() } finally { await parent.close() }
    }
  } else if (mode === 'generation') {
    if (input.length > 64 * 1024) throw failure('RESUME_GENERATION_INVALID')
    const plan = JSON.parse(input), targets = []
    if (plan.generation !== generation || !Array.isArray(plan.targets) || !plan.targets.length) throw failure('RESUME_GENERATION_INVALID')
    for (const selected of plan.targets) {
      checkResumeTarget(selected)
      const item = JSON.parse(await readResumeFile(join(directory, `${selected.session_id}.${selected.launch_id}.receipt.json`), 1024))
      if (item.session_id !== selected.session_id || item.launch_id !== selected.launch_id
        || item.file !== `${selected.session_id}.${selected.launch_id}.json`) throw failure('RESUME_GENERATION_INVALID')
      const bundle = await readResumeFile(join(directory, item.file))
      if (resumeDigest(bundle) !== item.checkpoint_sha256) throw failure('RESUME_CHECKPOINT_CHANGED')
      targets.push(item)
    }
    const { source_volume, home, ...record } = plan
    const bytes = Buffer.from(JSON.stringify({ ...record, targets }) + '\n')
    try { await publishResumeFile(directory, 'generation.json', bytes) }
    catch (error) { if (error.code !== 'EEXIST' || !(await readResumeFile(join(directory, 'generation.json'), 64 * 1024)).equals(bytes)) throw error }
  } else throw failure('RESUME_STORAGE_INVALID')
}
