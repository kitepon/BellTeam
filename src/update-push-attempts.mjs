import { randomUUID } from 'node:crypto'
import { mkdir, readFile, readdir } from 'node:fs/promises'
import { join } from 'node:path'
import { writeAtomic } from './json-file.mjs'

const uuid = value => typeof value === 'string' && /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/iu.test(value)
const time = value => value === null || typeof value === 'string' && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}\+09:00$/u.test(value) && Number.isFinite(Date.parse(value))
const integer = value => Number.isSafeInteger(value) && value >= 0
export const jstNow = () => new Date(Date.now() + 9 * 3600000).toISOString().replace('Z', '+09:00')
export const updatePushReason = code => typeof code === 'string' && /^(?:APNS_(?:HTTP_\d{3}(?:_[A-Z]{1,64})?|UNREGISTERED|CONNECTION_FAILED|TIMEOUT|RECEIPT_UNAVAILABLE)|PUSH_(?:ENVIRONMENT_UNAVAILABLE|NOT_CONFIGURED|NO_REGISTERED_DEVICES|ATTEMPT_SAVE_FAILED|RELAY_(?:CONNECTION_FAILED|RESPONSE_INVALID))|SUBSCRIPTION_REQUIRED)$/u.test(code) ? code : 'PUSH_SEND_FAILED'
export const apnsReceipt = value => ({
  sentAt: time(value?.sentAt) ? value.sentAt : null,
  apnsStatus: Number.isInteger(value?.apnsStatus) && value.apnsStatus >= 100 && value.apnsStatus <= 599 ? value.apnsStatus : null,
  apnsId: uuid(value?.apnsId) ? value.apnsId : null,
})

export function validateUpdateAttemptQuery(value = {}) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || Object.keys(value).some(key => !['attemptId', 'before', 'deviceOffset'].includes(key))
    || ['attemptId', 'before'].some(key => value[key] !== undefined && !uuid(value[key]))
    || value.attemptId !== undefined && value.before !== undefined
    || value.deviceOffset !== undefined && !integer(value.deviceOffset)) {
    throw Object.assign(new Error('PUSH_INPUT_INVALID'), { code: 'PUSH_INPUT_INVALID', status: 400 })
  }
}

function restore(value) {
  if (value?.schema !== 'bellteam.update-push-attempt.v1' || !uuid(value.attemptId)
    || !/^[a-f0-9]{64}$/u.test(value.candidateId ?? '') || !time(value.attemptedAt) || value.attemptedAt === null
    || !time(value.sentAt) || !time(value.completedAt) || !integer(value.targetDeviceCount)
    || !['pending', 'completed', 'not_sent', 'unknown'].includes(value.state)
    || value.errorReason !== null && updatePushReason(value.errorReason) !== value.errorReason
    || !Array.isArray(value.devices) || value.devices.length !== value.targetDeviceCount) throw new Error('PUSH_ATTEMPT_STATE_INVALID')
  const devices = value.devices.map((row, index) => {
    const receipt = apnsReceipt(row)
    if (row.device !== index + 1 || !['development', 'production'].includes(row.environment) || !time(row.sentAt)
      || !['pending', 'accepted', 'rejected', 'unknown', 'not_sent'].includes(row.outcome)
      || receipt.apnsStatus !== row.apnsStatus || receipt.apnsId !== row.apnsId
      || row.errorReason !== null && updatePushReason(row.errorReason) !== row.errorReason) throw new Error('PUSH_ATTEMPT_STATE_INVALID')
    return { device: row.device, environment: row.environment, sentAt: row.sentAt, ...receipt,
      outcome: row.outcome === 'pending' ? 'unknown' : row.outcome, errorReason: row.errorReason }
  })
  return { schema: value.schema, attemptId: value.attemptId, candidateId: value.candidateId,
    attemptedAt: value.attemptedAt, sentAt: value.sentAt, completedAt: value.completedAt,
    targetDeviceCount: value.targetDeviceCount, state: value.state === 'pending' ? 'unknown' : value.state,
    errorReason: value.errorReason, devices }
}

export class UpdatePushAttempts {
  constructor(root) {
    this.directory = join(root, 'state/update-push-attempts')
    this.items = []
    this.readError = null
    this.writeError = null
    this.failedSaves = new Set()
  }

  async initialize() {
    let names
    try { names = await readdir(this.directory) }
    catch (error) { if (error.code !== 'ENOENT') this.readError = 'PUSH_ATTEMPT_READ_FAILED'; return }
    for (const name of names) {
      if (!name.endsWith('.json') || !uuid(name.slice(0, -5))) continue
      try {
        const item = restore(JSON.parse(await readFile(join(this.directory, name), 'utf8')))
        if (item.attemptId !== name.slice(0, -5)) throw new Error('PUSH_ATTEMPT_STATE_INVALID')
        this.items.push(item)
      } catch { this.readError = 'PUSH_ATTEMPT_READ_FAILED' }
    }
    this.items.sort((a, b) => b.attemptedAt.localeCompare(a.attemptedAt) || b.attemptId.localeCompare(a.attemptId))
  }

  create(candidateId, devices, configured) {
    const item = { schema: 'bellteam.update-push-attempt.v1', attemptId: randomUUID(), candidateId,
      attemptedAt: jstNow(), sentAt: null, completedAt: null, targetDeviceCount: devices.length,
      state: configured && devices.length ? 'pending' : 'not_sent',
      errorReason: !configured ? 'PUSH_NOT_CONFIGURED' : !devices.length ? 'PUSH_NO_REGISTERED_DEVICES' : null,
      devices: devices.map((device, index) => ({ device: index + 1, environment: device.environment,
        sentAt: null, apnsStatus: null, apnsId: null, outcome: configured ? 'pending' : 'not_sent', errorReason: configured ? null : 'PUSH_NOT_CONFIGURED' })) }
    this.items.unshift(item)
    return item
  }

  async save(item) {
    try {
      await mkdir(this.directory, { recursive: true, mode: 0o700 })
      await writeAtomic(join(this.directory, `${item.attemptId}.json`), item)
      this.failedSaves.delete(item.attemptId)
      this.writeError = this.failedSaves.size ? 'PUSH_ATTEMPT_SAVE_FAILED' : null
      return true
    } catch { this.failedSaves.add(item.attemptId); this.writeError = 'PUSH_ATTEMPT_SAVE_FAILED'; return false }
  }

  status(options = {}) {
    validateUpdateAttemptQuery(options)
    const { attemptId, before, deviceOffset = 0 } = options
    const previous = before ? this.items.findIndex(item => item.attemptId === before) : -1
    const start = before && previous < 0 ? -1 : previous + 1
    const selected = attemptId ? this.items.filter(item => item.attemptId === attemptId)
      : start < 0 ? [] : this.items.slice(start, start + 5)
    const end = start + selected.length
    return {
      ...(this.items.length || Object.keys(options).length ? { updateAttempts: { total: this.items.length,
        nextBefore: !attemptId && selected.length && end < this.items.length ? selected.at(-1).attemptId : null,
        items: selected.map(item => ({ ...item, deviceOffset,
          nextDeviceOffset: deviceOffset + 20 < item.devices.length ? deviceOffset + 20 : null,
          devices: item.devices.slice(deviceOffset, deviceOffset + 20).map(row => ({ ...row })) })) } } : {}),
      ...(this.writeError || this.readError ? { updateAttemptStorageError: this.writeError ?? this.readError } : {}),
    }
  }
}
