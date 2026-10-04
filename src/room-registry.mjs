import { randomUUID } from 'node:crypto'
import { watch } from 'node:fs'
import { appendFile, mkdir, readFile, readdir, rm } from 'node:fs/promises'
import { dirname, join } from 'node:path'

import { exists, normalizeSchedule, scheduleDocument, validateAvatar, writeAtomic } from './bot-registry.mjs'

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
  }

  async initialize() {
    await mkdir(this.roomsRoot, { recursive: true })
    return this.refresh()
  }

  async refresh() {
    const rooms = []
    for (const entry of await readdir(this.roomsRoot, { withFileTypes: true })) {
      if (!entry.isDirectory() || !ROOM_ID.test(entry.name)) continue
      const path = join(this.roomsRoot, entry.name, 'room.json')
      if (!await exists(path)) continue
      rooms.push(await this.read(entry.name))
    }
    rooms.sort((a, b) => a.id.localeCompare(b.id))
    this.clear()
    for (const room of rooms) this.set(room.id, Object.freeze(room))
    return this
  }

  async create(input) {
    await this.bots.refresh?.()
    const id = this.roomId()
    validateId(id)
    const room = normalizeRoom({ ...input, id }, this.bots)
    const root = this.roomPath(id)
    await mkdir(root, { recursive: true })
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
    return { id }
  }

  async removeBot(botId) {
    await this.refresh()
    for (const room of [...this.values()].filter(value => value.memberIds.includes(botId))) {
      await this.update(room.id, {
        memberIds: room.memberIds.filter(id => id !== botId),
        representativeId: room.representativeId === botId ? null : room.representativeId,
      })
      const schedules = await this.listSchedules(room.id)
      await this.writeScheduleDocument(room.id, schedules.map(schedule => ({
        ...schedule,
        targets: schedule.targets?.filter(id => id !== botId) ?? null,
      })))
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
    let body
    try { body = await readFile(join(this.roomPath(id), 'messages.jsonl'), 'utf8') }
    catch (error) { if (error.code === 'ENOENT') return []; throw error }
    const messages = []
    const statuses = new Map()
    const routing = new Map()
    for (const line of body.split('\n').filter(Boolean)) {
      const record = JSON.parse(line)
      if (record?.schema === 'bellteam.room-delivery-status.v1') {
        statuses.set(`${record.message_id}\0${record.target}`, record.delivery)
      } else if (record?.schema === 'bellteam.room-routing-status.v1') {
        routing.set(record.message_id, record.routing)
      } else messages.push(record)
    }
    return messages.map(message => ({
      ...message,
      ...(Array.isArray(message.deliveries) ? {
        deliveries: message.deliveries.map(item => ({
          ...item,
          delivery: statuses.get(`${message.id}\0${item.target}`) ?? item.delivery,
        })),
      } : {}),
      routing: routing.get(message.id) ?? message.routing,
    }))
  }

  async appendMessage(id, record) {
    this.require(id)
    const path = join(this.roomPath(id), 'messages.jsonl')
    await mkdir(dirname(path), { recursive: true })
    await appendFile(path, `${JSON.stringify(record)}\n`, { mode: 0o600 })
  }

  async watch(onChange) {
    await mkdir(this.roomsRoot, { recursive: true })
    const watcher = watch(this.roomsRoot, { recursive: true }, (_event, name) => {
      if (name?.endsWith('messages.jsonl')) onChange()
    })
    return () => watcher.close()
  }

  async listSchedules(id) {
    this.require(id)
    return (await this.readScheduleDocument(id)).schedules
  }

  async setSchedule(id, input) {
    const room = this.require(id)
    const document = await this.readScheduleDocument(id)
    const existing = input.id ? document.schedules.find(item => item.id === input.id) : null
    if (input.id && !existing) throw new Error(`SCHEDULE_NOT_FOUND: ${input.id}`)
    const targets = input.targets == null ? null : uniqueMembers(input.targets, room.memberIds)
    if (input.command !== undefined) throw new Error('SCHEDULE_COMMAND_ROOM_UNSUPPORTED')
    const schedule = { ...normalizeSchedule({ ...input, id: input.id ?? this.id(), lastRunAt: null }, this.now()), targets }
    const schedules = existing
      ? document.schedules.map(item => item.id === schedule.id ? schedule : item)
      : [...document.schedules, schedule]
    await this.writeScheduleDocument(id, schedules)
    return schedule
  }

  async removeSchedule(id, scheduleId) {
    const schedules = await this.listSchedules(id)
    if (!schedules.some(item => item.id === scheduleId)) throw new Error(`SCHEDULE_NOT_FOUND: ${scheduleId}`)
    await this.writeScheduleDocument(id, schedules.filter(item => item.id !== scheduleId))
  }

  async markScheduleRun(id, scheduleId, ranAt) {
    const schedules = await this.listSchedules(id)
    const current = schedules.find(item => item.id === scheduleId)
    if (!current) throw new Error(`SCHEDULE_NOT_FOUND: ${scheduleId}`)
    const base = normalizeSchedule({ ...current, lastRunAt: new Date(ranAt).toISOString(), enabled: current.kind === 'once' ? false : current.enabled }, new Date(ranAt))
    const updated = { ...base, targets: current.targets ?? null }
    await this.writeScheduleDocument(id, schedules.map(item => item.id === scheduleId ? updated : item))
    return updated
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
