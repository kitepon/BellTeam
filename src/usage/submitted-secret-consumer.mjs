import { constants } from 'node:fs'
import { mkdir, open, realpath } from 'node:fs/promises'
import { isAbsolute, join } from 'node:path'
import { authCodeChallenge } from '../auth-ui.mjs'

const id = value => typeof value === 'string' && /^[a-z0-9][a-z0-9-]{0,63}$/u.test(value)
const result = (requestId, outcome, reason, authStatus = null) => ({ schema: 'bellteam.submitted-secret-result.v1', requestId, outcome, reason, authStatus })
const syncDirectory = async path => { const fd = await open(path, constants.O_RDONLY); try { await fd.sync() } finally { await fd.close() } }
const inputReceiptValid = receipt => receipt && Object.keys(receipt).sort().join(',') === 'authStatus,httpStatus,outcome,schema'
  && receipt.schema === 'bellteam.submitted-secret-input.v1' && ['issued', 'unknown'].includes(receipt.outcome)
  && [null, 'authenticated', 'waiting', 'blocked', 'failed'].includes(receipt.authStatus)
  && (receipt.httpStatus === null || Number.isInteger(receipt.httpStatus) && receipt.httpStatus >= 100 && receipt.httpStatus <= 599)
  && (receipt.outcome !== 'issued' || receipt.httpStatus >= 200 && receipt.httpStatus < 300 && receipt.authStatus !== null)

// The parent captures both authorization and the fixed target; neither is an HTTP field.
export function createSubmittedSecretConsumer({ secretRequests, runDirectory, context, assertAuthorized, consume }) {
  const plan = structuredClone(context)
  if (!plan || !id(plan.requestId) || !id(plan.requesterBotId) || !id(plan.toolId)
    || plan.roomId !== null && !id(plan.roomId) || !isAbsolute(runDirectory)
    || !isAbsolute(secretRequests?.toolsDirectory ?? '') || typeof secretRequests?.read !== 'function'
    || typeof assertAuthorized !== 'function' || typeof consume !== 'function') throw new Error('SECRET_CONSUMER_CONTEXT_INVALID')
  const controller = new AbortController()
  let started = false
  const pending = new Set()
  const execute = async ({ requestId, challenge, admission, signal } = {}) => {
    if (requestId !== plan.requestId) return result(plan.requestId, 'not_issued', 'wrong_request')
    if (!admission || typeof admission !== 'object') return result(plan.requestId, 'not_issued', 'not_authorized')
    try { challenge = authCodeChallenge(challenge) }
    catch { return result(plan.requestId, 'not_issued', 'invalid_challenge') }
    if (started) return result(plan.requestId, 'not_issued', 'already_started')
    started = true
    const abortSignal = signal ? AbortSignal.any([signal, controller.signal]) : controller.signal
    const check = () => { if (abortSignal.aborted) throw new Error('SECRET_CONSUMER_INTERRUPTED') }
    const authorized = async () => { check(); if (await assertAuthorized(admission, challenge) !== undefined) throw new Error('SECRET_CONSUMER_FORBIDDEN'); check() }
    let claim, bytes, issuing = false, reason = 'not_authorized'
    try {
      await authorized()
      reason = 'request_unavailable'
      const item = await secretRequests.read(plan.requestId)
      const expected = join(secretRequests.toolsDirectory, plan.toolId, 'secrets', plan.requestId)
      if (item.id !== plan.requestId || item.botId !== plan.requesterBotId || item.toolId !== plan.toolId
        || item.roomId !== plan.roomId || item.status !== 'submitted' || item.path !== expected) {
        return result(plan.requestId, 'not_issued', 'wrong_request')
      }
      await authorized()
      reason = 'storage_unavailable'
      await mkdir(runDirectory, { recursive: true, mode: 0o700 })
      if (await realpath(runDirectory) !== runDirectory) throw new Error('SECRET_CONSUMER_STORAGE_INVALID')
      const directory = await open(runDirectory, constants.O_RDONLY | constants.O_NOFOLLOW)
      try {
        const stat = await directory.stat()
        if (!stat.isDirectory() || stat.uid !== process.getuid() || (stat.mode & 0o777) !== 0o700) throw new Error('SECRET_CONSUMER_STORAGE_INVALID')
      } finally { await directory.close() }
      check()
      try { claim = await open(join(runDirectory, plan.requestId + '.claim'), 'wx', 0o600) }
      catch (error) { if (error.code === 'EEXIST') return result(plan.requestId, 'not_issued', 'already_claimed'); throw error }
      await claim.writeFile(JSON.stringify(result(plan.requestId, 'unknown', 'claimed')) + '\n')
      await claim.sync()
      await syncDirectory(runDirectory)
      reason = 'not_authorized'
      await authorized()
      reason = 'secret_unavailable'
      if (await realpath(expected) !== expected) throw new Error('SECRET_CONSUMER_FILE_INVALID')
      const file = await open(expected, constants.O_RDONLY | constants.O_NOFOLLOW)
      let value
      try {
        const stat = await file.stat()
        if (!stat.isFile() || stat.nlink !== 1 || stat.uid !== process.getuid() || (stat.mode & 0o777) !== 0o600
          || stat.size < 1 || stat.size > 8192) throw new Error('SECRET_CONSUMER_FILE_INVALID')
        bytes = Buffer.alloc(8193)
        const { bytesRead } = await file.read(bytes, 0, bytes.length, 0)
        if (bytesRead !== stat.size || bytesRead > 8192) throw new Error('SECRET_CONSUMER_FILE_INVALID')
        value = bytes.subarray(0, bytesRead).toString('utf8').trim()
        if (!/^[!-~]+$/u.test(value)) throw new Error('SECRET_CONSUMER_VALUE_INVALID')
      } finally { await file.close() }
      reason = 'not_authorized'
      await authorized()
      const assertBeforeIssue = () => check()
      check()
      issuing = true
      const receipt = await consume({ ...challenge, response: { kind: 'authorization_code', value } }, { signal: abortSignal, assertBeforeIssue })
      value = null
      if (!inputReceiptValid(receipt)) throw new Error('SECRET_CONSUMER_RECEIPT_INVALID')
      const terminal = result(plan.requestId, receipt.outcome, receipt.outcome === 'issued' ? 'input_completed' : 'input_unknown', receipt.authStatus)
      await claim.writeFile(JSON.stringify(terminal) + '\n')
      await claim.sync()
      return terminal
    } catch {
      return result(plan.requestId, claim || issuing ? 'unknown' : 'not_issued', issuing ? 'input_unknown' : abortSignal.aborted ? 'interrupted' : reason)
    } finally {
      bytes?.fill(0)
      try { await claim?.close() } catch {}
    }
  }
  return {
    execute(input) {
      const operation = execute(input); pending.add(operation)
      operation.then(() => pending.delete(operation), () => pending.delete(operation))
      return operation
    },
    async close() { controller.abort(); await Promise.allSettled([...pending]) },
  }
}
