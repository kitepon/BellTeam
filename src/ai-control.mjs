import { mkdir, open, readFile, rename, unlink } from 'node:fs/promises'
import { dirname } from 'node:path'
import { randomUUID } from 'node:crypto'

export function aiControlError(code, status, message) {
  return Object.assign(new Error(message), { code, status, publicMessage: message })
}

export function stopRegisteredWork({ bots, transport, scheduler }) {
  const targets = new Map([...bots.values()].map(bot => [bot.id, bot]))
  for (const job of transport.jobs) targets.set(job.bot.id, job.bot)
  if (transport.executionBridge) {
    let stopping, commands
    try { stopping = transport.interruptMany([...targets.values()]) } catch (error) { stopping = Promise.reject(error) }
    try { commands = scheduler.interruptCommands() } catch { commands = false }
    return Promise.all([stopping, Promise.resolve(commands).catch(() => false)])
      .then(([result, commandsConfirmed]) => ({ unconfirmedBotIds: result.unconfirmedBotIds, commandsConfirmed: commandsConfirmed === true }))
  }
  // Establish every barrier synchronously, even if one target rejects.
  const stopping = [...targets.values()].map(bot => {
    try { return { bot, result: transport.interrupt(bot) } }
    catch (error) { return { bot, result: Promise.reject(error) } }
  })
  let commands
  try { commands = scheduler.interruptCommands() } catch { commands = false }
  return Promise.all([Promise.allSettled(stopping.map(item => item.result)), Promise.resolve(commands).catch(() => false)])
    .then(([results, commandsConfirmed]) => ({
      unconfirmedBotIds: stopping.filter((item, i) => {
        const result = results[i]
        return result.status !== 'fulfilled' || result.value?.botId !== item.bot.id
          || result.value?.status !== 'interrupted' || result.value?.sessionPreserved !== true
      }).map(item => item.bot.id),
      commandsConfirmed: commandsConfirmed === true,
    }))
}

async function writeState(path, value) {
  await mkdir(dirname(path), { recursive: true })
  const temp = `${path}.${randomUUID()}.tmp`
  let created = false
  let file
  try {
    file = await open(temp, 'wx', 0o600)
    created = true
    await file.writeFile(JSON.stringify(value) + '\n')
    await file.sync()
    await file.close()
    file = null
    await rename(temp, path)
    const parent = await open(dirname(path), 'r')
    try { await parent.sync() } finally { await parent.close() }
  } finally {
    await file?.close()
    if (created) await unlink(temp).catch(error => { if (error.code !== 'ENOENT') throw error })
  }
}

// The persistent value is the owner's pause intent, not a cached stop receipt.
export class AiControl {
  constructor({ path, stopAll, beforeResume = async () => {}, save = writeState, now = () => new Date().toISOString() }) {
    this.path = path
    this.stopAll = stopAll
    this.beforeResume = beforeResume
    this.save = save
    this.now = now
    this.paused = false
    this.desired = false
    this.state = 'enabled'
    this.updatedAt = null
    this.resumedAt = null
    this.unconfirmedBotIds = []
    this.commandsConfirmed = null
    this.error = null
    this.revision = 0
    this.pauseEpoch = 0
    this.writes = Promise.resolve()
    this.enforcement = null
    this.pendingIntent = null
    this.listeners = new Set()
  }

  async initialize() {
    try {
      const value = JSON.parse(await readFile(this.path, 'utf8'))
      if (value?.schema !== 'bellteam.ai-control.v1' || typeof value.paused !== 'boolean'
        || typeof value.updatedAt !== 'string' || !Number.isFinite(Date.parse(value.updatedAt)))
        throw new Error('INVALID_CONTROL')
      this.paused = value.paused
      this.updatedAt = value.updatedAt
      if (value.resumedAt != null && (typeof value.resumedAt !== 'string' || !Number.isFinite(Date.parse(value.resumedAt))))
        throw new Error('INVALID_CONTROL')
      this.resumedAt = value.resumedAt ?? null
      // Re-observe after restart. A saved ON is not evidence of a current interruption.
      this.state = this.paused ? 'unconfirmed' : 'enabled'
      this.error = this.paused ? 'AI_STOP_UNCONFIRMED' : null
    } catch (error) {
      if (error.code !== 'ENOENT') {
        this.paused = true
        this.state = 'unconfirmed'
        this.error = 'AI_CONTROL_STATE_INVALID'
      }
    }
    this.desired = this.paused
    return this.snapshot()
  }

  snapshot() {
    return { paused: this.paused, state: this.state, updatedAt: this.updatedAt,
      unconfirmedBotIds: [...this.unconfirmedBotIds], commandsConfirmed: this.commandsConfirmed, error: this.error }
  }

  assertEnabled() {
    if (this.paused) throw aiControlError('AI_GLOBAL_PAUSED', 423, 'BellTeam全体を停止しています。設定で停止を解除してください。')
  }

  admit() {
    this.assertEnabled()
    const epoch = this.pauseEpoch
    return () => {
      this.assertEnabled()
      if (epoch !== this.pauseEpoch) throw aiControlError('BOT_STOPPED', 409, 'この依頼は全体停止で取り消されました。')
    }
  }

  watch(listener) {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  changed() { for (const listener of this.listeners) { try { listener(this.snapshot()) } catch {} } }

  update(paused) {
    if (typeof paused !== 'boolean') throw aiControlError('AI_CONTROL_INVALID', 400, '停止設定はONかOFFで指定してください。')
    if (!paused && !this.paused && !this.desired && !this.pendingIntent)
      return Promise.resolve({ status: 200, control: this.snapshot() })
    if (paused && this.desired && this.pendingIntent?.paused) return this.pendingIntent.operation
    if (paused && this.desired && this.state === 'stopped') return Promise.resolve({ status: 200, control: this.snapshot() })
    if (paused && this.desired && this.enforcement) return Promise.resolve({ status: 202, control: this.snapshot() })
    this.desired = paused
    const revision = ++this.revision
    // Close admission synchronously, before storage or any stop RPC can await.
    if (paused) {
      this.pauseEpoch++
      this.paused = true
      this.state = 'stopping'
      this.error = null
      this.changed()
      // Emergency action precedes disk acknowledgement. A blocked or failed
      // state write must never delay sending the interruption.
      this.enforce(revision)
    }
    const operation = this.writes.then(async () => {
      const updatedAt = this.now()
      const resumedAt = !paused ? updatedAt : this.resumedAt
      let saved = true
      try {
        if (!paused) await this.beforeResume(updatedAt)
        await this.save(this.path, { schema: 'bellteam.ai-control.v1', paused, updatedAt, resumedAt })
      }
      catch { saved = false }
      if (!saved) {
        this.paused = true
        this.state = 'unconfirmed'
        this.error = 'AI_CONTROL_SAVE_FAILED'
        this.changed()
        return { status: 503, error: 'AI_CONTROL_SAVE_FAILED', control: this.snapshot() }
      }
      this.updatedAt = updatedAt
      this.resumedAt = resumedAt
      if (!paused && revision === this.revision) {
        this.paused = false
        this.state = 'enabled'
        this.error = null
        this.unconfirmedBotIds = []
        this.commandsConfirmed = null
      }
      this.changed()
      return { status: paused ? 202 : 200, control: this.snapshot() }
    })
    this.writes = operation.then(() => {}, () => {})
    const pendingIntent = { paused, operation }
    this.pendingIntent = pendingIntent
    const clear = () => { if (this.pendingIntent === pendingIntent) this.pendingIntent = null }
    operation.then(clear, clear)
    return operation
  }

  enforce(revision = this.revision, saved = this.error !== 'AI_CONTROL_STATE_INVALID') {
    if (!this.paused) return Promise.resolve()
    this.state = saved ? 'stopping' : 'unconfirmed'
    this.changed()
    // stopAll must synchronously establish all per-target barriers before awaiting.
    let stopping
    try { stopping = this.stopAll() } catch { stopping = Promise.reject(new Error('STOP_FAILED')) }
    const operation = Promise.resolve(stopping).then(result => {
      if (revision !== this.revision || !this.paused) return
      if (!result || !Array.isArray(result.unconfirmedBotIds) || !result.unconfirmedBotIds.every(id => typeof id === 'string')
        || typeof result.commandsConfirmed !== 'boolean')
        throw new Error('STOP_RESULT_INVALID')
      this.unconfirmedBotIds = [...new Set(result.unconfirmedBotIds)].sort()
      this.commandsConfirmed = result.commandsConfirmed
      const persisted = saved && !['AI_CONTROL_SAVE_FAILED', 'AI_CONTROL_STATE_INVALID'].includes(this.error)
      this.state = persisted && !this.unconfirmedBotIds.length && result.commandsConfirmed ? 'stopped' : 'unconfirmed'
      this.error = !persisted ? (this.error ?? 'AI_CONTROL_SAVE_FAILED') : this.state === 'unconfirmed' ? 'AI_STOP_UNCONFIRMED' : null
    }).catch(() => {
      if (revision !== this.revision || !this.paused) return
      this.state = 'unconfirmed'
      this.error ??= 'AI_STOP_UNCONFIRMED'
    }).finally(() => {
      if (this.enforcement === operation) this.enforcement = null
      this.changed()
    })
    this.enforcement = operation
    return operation
  }
}
