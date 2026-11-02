import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'

export const RESUME_BUNDLE_BYTES = 16 * 1024 * 1024
export const RESUME_RECEIPT_BYTES = 512
export const resumeDigest = bytes => createHash('sha256').update(bytes).digest('hex')
const failure = code => Object.assign(new Error(code), { code })

export function checkResumeTarget(target) {
  if (!target || typeof target.session_id !== 'string' || typeof target.launch_id !== 'string'
    || !/^[A-Za-z0-9_-]{1,64}$/.test(target.session_id)
    || !/^[a-f0-9]{32}$/.test(target.launch_id)) throw failure('RESUME_TARGET_INVALID')
  return target
}

export function checkResumeReceipt(bytes, operation, target, digest) {
  checkResumeTarget(target)
  try {
    if (!Buffer.isBuffer(bytes) || bytes.length > RESUME_RECEIPT_BYTES || bytes.at(-1) !== 10) throw Error()
    const text = bytes.toString('utf8'), receipt = JSON.parse(text)
    if (text.split('\n').length !== 2 || Object.keys(receipt).sort().join(',')
      !== 'checkpoint_sha256,launch_id,operation,outcome,schema,session_id'
      || receipt.schema !== 'aiterm.resume-state-result.v1' || receipt.operation !== operation
      || receipt.session_id !== target.session_id || receipt.launch_id !== target.launch_id
      || receipt.checkpoint_sha256 !== digest
      || !(operation === 'checkpoint' ? ['saved'] : ['restored', 'already_restored']).includes(receipt.outcome)) throw Error()
    return receipt
  } catch { throw failure('RESUME_RECEIPT_INVALID') }
}

// This is H1's byte protocol, not the generic text runner's shared buffer limit.
export function runResumePipe(spec, operation, target, { input, signal } = {}) {
  checkResumeTarget(target)
  if (!['checkpoint', 'restore'].includes(operation) || operation === 'restore'
    && (!Buffer.isBuffer(input) || !input.length || input.length > RESUME_BUNDLE_BYTES || input.at(-1) !== 10))
    throw failure('RESUME_INPUT_INVALID')
  if (signal?.aborted) return Promise.reject(failure('ABORT_ERR'))
  return new Promise((resolve, reject) => {
    const child = spawn(spec.command, spec.args, { cwd: spec.cwd, env: spec.env, stdio: ['pipe', 'pipe', 'pipe'] })
    const stdout = [], stderr = [], sizes = [0, 0]
    let stopped
    const stop = code => { if (!stopped) { stopped = code; child.kill('SIGTERM') } }
    const abort = () => stop('ABORT_ERR')
    signal?.addEventListener('abort', abort, { once: true })
    if (signal?.aborted) abort()
    const capture = (list, index, limit) => chunk => {
      sizes[index] += chunk.length
      if (sizes[index] > limit) stop('RESUME_STREAM_EXCEEDED')
      else if (!stopped) list.push(chunk)
    }
    child.stdout.on('data', capture(stdout, 0, operation === 'checkpoint' ? RESUME_BUNDLE_BYTES : RESUME_RECEIPT_BYTES))
    child.stderr.on('data', capture(stderr, 1, RESUME_RECEIPT_BYTES))
    child.once('error', () => { stopped = 'RESUME_PROCESS_START_FAILED' })
    child.stdin.on('error', () => stop('RESUME_PIPE_FAILED'))
    child.once('close', (code, exitSignal) => {
      signal?.removeEventListener('abort', abort)
      if (stopped || code !== 0 || exitSignal) return reject(failure(stopped ?? 'RESUME_PROCESS_FAILED'))
      try {
        const out = Buffer.concat(stdout), err = Buffer.concat(stderr)
        const bundle = operation === 'checkpoint' ? out : input
        if (!bundle.length || bundle.at(-1) !== 10 || operation === 'restore' && err.length)
          throw failure('RESUME_STREAM_INVALID')
        const receipt = checkResumeReceipt(operation === 'checkpoint' ? err : out, operation, target, resumeDigest(bundle))
        resolve({ bundle, receipt })
      } catch (error) { reject(error) }
    })
    child.stdin.end(input)
  })
}
