import { randomUUID } from 'node:crypto'
import { watch } from 'node:fs'
import { appendFile, chmod, mkdir, readFile, readdir, rm, stat } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'

import { exists, normalizeSchedule, scheduleDocument, validateAvatar, writeAtomic } from './bot-registry.mjs'
import { RoomHistory } from './room-history.mjs'
import { mutateSchedules, nextScheduleRevision, scheduleRevision } from './schedule-mutations.mjs'

const ROOM_ID = /^[a-z0-9][a-z0-9-]{0,63}$/u
const FIELDS = new Set(['name', 'purpose', 'representativeId', 'memberIds', 'avatar'])

export class RoomRegistry extends Map {
  constructor({ roomsRoot, bots, now = () => new Date(), id = randomUUID, roomId = () => `room-${randomUUID().slice(0, 8)}` }) {
    super()
    this.roomsRoot = roomsRoot
    this.bots = bots
    this.now = now
    this.id = id
    this.roomId = roomId
    this.histories = new Map()
    this.definitions = new Map()
  }

  async initialize() {
    await mkdir(this.roomsRoot, { recursive: true, mode: 0o700 })
    for (const entry of await readdir(this.roomsRoot, { withFileTypes: true })) {
      if (entry.isDirectory() && ROOM_ID.test(entry.name)) await chmod(this.roomPath(entry.name), 0o700)
    }
    return this.refresh()
  }

  async refresh() {
    const rooms = [], definitions = new Map()
    for (const entry of await readdir(this.roomsRoot, { withFileTypes: true })) {
      if (!entry.isDirectory() || !ROOM_ID.test(entry.name)) continue
      const path = join(this.roomsRoot, entry.name, 'room.json')
      let info
      try { info = await stat(path, { bigint: true }) }
      catch (error) { if (error.code === 'ENOENT') continue; throw error }
      const signature = `${info.dev}:${info.ino}:${info.size}:${info.mtimeNs}:${info.ctimeNs}`
      const cached = this.definitions.get(entry.name)
      const room = cached?.signature === signature ? normalizeRoom(cached.room, this.bots) : await this.read(entry.name)
      definitions.set(entry.name, { signature, room })
      rooms.push(room)
    }
    rooms.sort((a, b) => a.id.localeCompare(b.id))
    this.clear()
    for (const room of rooms) this.set(room.id, Object.freeze(room))
    this.definitions = definitions
    for (const id of this.histories.keys()) if (!this.has(id)) this.histories.delete(id)
    return this
  }

  async create(input) {
    await this.bots.refresh?.()
    const id = this.roomId()
    validateId(id)
    const room = normalizeRoom({ ...input, id }, this.bots)
    const root = this.roomPath(id)
    await mkdir(root, { recursive: true, mode: 0o700 })
    await writeAtomic(join(root, 'room.json'), { schema: 'bellteam.room.v1', ...room })
    await writeAtomic(join(root, 'schedule.json'), scheduleDocument([]))
    await this.refresh()
    return this.get(id)
  }

  async update(id, changes) {
    await this.refresh()
    await this.bots.refresh?.()
    const current = this.get(id)
    if (!current) throw new Error(`ROOM_NOT_FOUND: ${id}`)
    for (const key of Object.keys(changes ?? {})) if (!FIELDS.has(key)) throw new Error(`ROOM_UPDATE_FIELD_INVALID: ${key}`)
    const merged = { ...current, ...changes }
    if (!Object.hasOwn(changes, 'representativeId') && !merged.memberIds.includes(current.representativeId))
      merged.representativeId = null
    const room = normalizeRoom(merged, this.bots)
    await writeAtomic(join(this.roomPath(id), 'room.json'), { schema: 'bellteam.room.v1', ...room })
    await this.refresh()
    return this.get(id)
  }

  async remove(id) {
    await this.refresh()
    this.require(id)
    await rm(this.roomPath(id), { recursive: true })
    this.delete(id)
    this.histories.delete(id)
    return { id }
  }

  async removeBot(botId) {
    await this.refresh()
    for (const room of [...this.values()].filter(value => value.memberIds.includes(botId))) {
      await this.update(room.id, {
        memberIds: room.memberIds.filter(id => id !== botId),
        representativeId: room.representativeId === botId ? null : room.representativeId,
      })
      await mutateSchedules(this, room.id, schedules => ({ schedules: schedules.map(schedule => ({
        ...schedule,
        targets: schedule.targets?.filter(id => id !== botId) ?? null,
      })) }))
    }
  }

  async read(id) {
    const value = JSON.parse(await readFile(join(this.roomPath(id), 'room.json'), 'utf8'))
    if (value?.schema !== 'bellteam.room.v1') throw new Error(`ROOM_FILE_INVALID: ${id}`)
    return normalizeRoom({ ...value, id }, this.bots)
  }

  roomPath(id) {
    validateId(id)
    return join(this.roomsRoot, id)
  }

  async messages(id) {
    this.require(id)
    if (!this.histories.has(id)) this.histories.set(id, new RoomHistory(join(this.roomPath(id), 'messages.jsonl')))
    return this.histories.get(id).messages()
  }

  async messageView(id) {
    this.require(id)
    if (!this.histories.has(id)) this.histories.set(id, new RoomHistory(join(this.roomPath(id), 'messages.jsonl')))
    return this.histories.get(id).view()
  }

  async appendMessage(id, record) {
    this.require(id)
    const path = join(this.roomPath(id), 'messages.jsonl')
    await mkdir(dirname(path), { recursive: true })
    await appendFile(path, `${JSON.stringify(record)}\n`, { mode: 0o600 })
  }

  async watch(onChange) {
    await mkdir(this.roomsRoot, { recursive: true })
    const files = { 'room.json': 'rooms', 'schedule.json': 'schedules', 'messages.jsonl': 'timeline' }
    const observed = new Map(), names = new Set()
    let pending = Promise.resolve(), queued = false, closed = false
    const unknown = () => { if (!closed) onChange({ all: true, topics: ['rooms', 'schedules', 'timeline'], botIds: [], roomIds: [] }) }
    const info = async (id, file) => {
      try {
        const value = await stat(join(this.roomPath(id), file), { bigint: true })
        return { ino: `${value.dev}:${value.ino}`, size: value.size, time: `${value.mtimeNs}:${value.ctimeNs}` }
      } catch (error) { if (error.code === 'ENOENT') return null; throw error }
    }
    const ids = async () => (await readdir(this.roomsRoot, { withFileTypes: true }))
      .filter(entry => entry.isDirectory() && ROOM_ID.test(entry.name)).map(entry => entry.name)
    const same = (a, b) => a === b || (a && b && a.ino === b.ino && a.size === b.size && a.time === b.time)
    const reconcile = async targets => {
      for (const [id, selected] of targets) {
        const previous = observed.get(id) ?? new Map(), current = new Map(previous), topics = []
        let all = false
        for (const file of selected) {
          const before = previous.get(file) ?? null, after = await info(id, file)
          current.set(file, after)
          if (same(before, after)) continue
          topics.push(files[file])
          // 履歴の初出・置換・縮小・同サイズ書換えは従来どおり全体照合する。
          if (file === 'messages.jsonl' && (!before || !after || before.ino !== after.ino
            || after.size < before.size || (after.size === before.size && after.time !== before.time))) all = true
        }
        if ([...current.values()].some(Boolean)) observed.set(id, current)
        else observed.delete(id)
        if (!closed && topics.length) onChange({ all, topics, botIds: [], roomIds: [id] })
      }
    }
    const dispatch = async batch => {
      const targets = new Map()
      const add = (id, selected) => targets.set(id, new Set([...(targets.get(id) ?? []), ...selected]))
      let scan = false
      for (const name of batch) {
        const parts = typeof name === 'string' ? name.split(/[\\/]/u) : []
        // Macは親名やroot名だけを返す。名前を推測せずstat差分で対象を確定する。
        if (name === basename(this.roomsRoot) || !ROOM_ID.test(parts[0] ?? '') || parts.length > 2) scan = true
        else if (parts.length === 1) add(parts[0], Object.keys(files))
        else if (files[parts[1]]) add(parts[0], [parts[1]])
      }
      if (scan) for (const id of new Set([...observed.keys(), ...await ids()])) add(id, Object.keys(files))
      await reconcile(targets)
    }
    const enqueue = name => {
      names.add(name)
      // 処理中の通知は次の一群へまとめる。時間で変更を隠すキャッシュは使わない。
      if (!queued) {
        queued = true
        pending = pending.then(async () => {
          queued = false
          const batch = [...names]; names.clear()
          if (!closed) await dispatch(batch)
        }).catch(unknown)
      }
      return pending
    }
    const watcher = watch(this.roomsRoot, { recursive: true }, (_event, name) => enqueue(name))
    watcher.on('error', unknown)
    // 初回・再接続はreadyで全体照合する。監視登録中の通知は初期statの後に処理する。
    pending = (async () => {
      for (const id of await ids()) {
        const initial = new Map()
        for (const file of Object.keys(files)) initial.set(file, await info(id, file))
        observed.set(id, initial)
      }
    })().catch(unknown)
    await pending
    return () => { closed = true; watcher.close() }
  }

  async listSchedules(id) {
    this.require(id)
    return (await this.readScheduleDocument(id)).schedules
  }

  async setSchedule(id, input) {
    const room = this.require(id)
    return mutateSchedules(this, id, schedules => {
      const existing = input.id ? schedules.find(item => item.id === input.id) : null
      if (input.id && !existing) throw new Error(`SCHEDULE_NOT_FOUND: ${input.id}`)
      const targets = input.targets == null ? null : uniqueMembers(input.targets, room.memberIds)
      if (input.command !== undefined) throw new Error('SCHEDULE_COMMAND_ROOM_UNSUPPORTED')
      const schedule = { ...normalizeSchedule({ ...input, id: input.id ?? this.id(), lastRunAt: null, revision: nextScheduleRevision(existing) }, this.now()), targets }
      return { schedules: existing ? schedules.map(item => item.id === schedule.id ? schedule : item) : [...schedules, schedule], value: schedule }
    })
  }

  async removeSchedule(id, scheduleId) {
    return mutateSchedules(this, id, schedules => {
      if (!schedules.some(item => item.id === scheduleId)) throw new Error(`SCHEDULE_NOT_FOUND: ${scheduleId}`)
      return { schedules: schedules.filter(item => item.id !== scheduleId) }
    })
  }

  async markScheduleRun(id, scheduleId, ranAt, { skipped = false, expectedRevision } = {}) {
    return mutateSchedules(this, id, schedules => {
      const current = schedules.find(item => item.id === scheduleId)
      if (expectedRevision !== undefined && (!current || scheduleRevision(current) !== expectedRevision)) return { value: current ?? null }
      if (!current) throw new Error(`SCHEDULE_NOT_FOUND: ${scheduleId}`)
      const base = normalizeSchedule({ ...current, lastRunAt: skipped ? current.lastRunAt : new Date(ranAt).toISOString(), enabled: current.kind === 'once' ? false : current.enabled }, new Date(ranAt))
      const updated = { ...base, targets: current.targets ?? null }
      return { schedules: schedules.map(item => item.id === scheduleId ? updated : item), value: updated }
    })
  }

  require(id) {
    const room = this.get(id)
    if (!room) throw new Error(`ROOM_NOT_FOUND: ${id}`)
    return room
  }

  async readScheduleDocument(id) {
    const path = join(this.roomPath(id), 'schedule.json')
    if (!await exists(path)) await writeAtomic(path, scheduleDocument([]))
    const value = JSON.parse(await readFile(path, 'utf8'))
    if (value?.schema !== 'bellteam.schedule.v1' || !Array.isArray(value.schedules)) throw new Error(`SCHEDULE_FILE_INVALID: ${id}`)
    return value
  }

  writeScheduleDocument(id, schedules) {
    return writeAtomic(join(this.roomPath(id), 'schedule.json'), scheduleDocument(schedules))
  }
}

function normalizeRoom(value, bots) {
  validateId(value.id)
  if (typeof value.name !== 'string' || !value.name.trim() || value.name.length > 100) throw new Error('ROOM_NAME_INVALID')
  if (typeof (value.purpose ?? '') !== 'string' || (value.purpose ?? '').length > 8000) throw new Error('ROOM_PURPOSE_INVALID')
  const memberIds = uniqueMembers(value.memberIds, [...bots.keys()])
  const representativeId = value.representativeId || null
  if (representativeId && !memberIds.includes(representativeId)) throw new Error('ROOM_REPRESENTATIVE_INVALID')
  validateAvatar(value.avatar ?? '', 'ROOM_AVATAR_INVALID')
  return { id: value.id, name: value.name.trim(), purpose: value.purpose ?? '', representativeId, memberIds, avatar: value.avatar ?? '' }
}

function uniqueMembers(values, allowed) {
  if (!Array.isArray(values)) throw new Error('ROOM_MEMBERS_INVALID')
  const result = [...new Set(values)]
  if (result.some(id => !allowed.includes(id))) throw new Error('ROOM_MEMBERS_INVALID')
  return result
}

function validateId(id) {
  if (typeof id !== 'string' || !ROOM_ID.test(id)) throw new Error('ROOM_ID_INVALID')
}
