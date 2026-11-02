import { objectSchema } from '../mcp-schema.mjs'
import { requireRoomMember, requireRepresentative } from '../room-access.mjs'

const intervalScheduleProperties = {
  intervalDays: { type: 'integer', minimum: 1, description: 'interval_days用。開始日から何日おきに実行するか。2なら開始日・2日後・4日後。' },
  startDate: { type: 'string', description: 'interval_days用。開始日（YYYY-MM-DD、指定timezoneの暦日）。' },
  time: { type: 'string', description: 'interval_days用。実行時刻（HH:mm）。' },
  intervalHours: { type: 'integer', minimum: 1, maximum: 24, description: 'interval_hours用。毎日の開始時刻から何時間おきに実行するか。' },
  startHour: { type: 'integer', minimum: 0, maximum: 23, description: 'interval_hours用。開始時（含む）。' },
  endHour: { type: 'integer', minimum: 0, maximum: 23, description: 'interval_hours用。終了時（含む）。開始より小さければ翌日、同じなら一回。' },
  minute: { type: 'integer', minimum: 0, maximum: 59, description: 'interval_hours用。実行する分。既定は0。' },
}

export const botScheduleTools = [
  {
    name: 'set_schedule',
    description: 'Botの自動実行予定を追加または更新する。一回はkind=onceとat、cron式はkind=cronとexpression、日おきはkind=interval_daysとintervalDays・startDate・time、時間帯内の時間おきはkind=interval_hoursとintervalHours・startHour・endHourを使う。実行内容はpromptかcommandのどちらか一方。AIを起こす必要のない作業（スクリプト実行など）はpromptでなくcommandにする。botId省略時は自分。',
    inputSchema: objectSchema({
      id: { type: 'string', description: '更新する予定ID。新規追加では省略する。' },
      name: { type: 'string', maxLength: 100 },
      kind: { type: 'string', enum: ['once', 'cron', 'interval_days', 'interval_hours'] },
      ...intervalScheduleProperties,
      at: { type: 'string', description: '一回実行のISO日時' },
      expression: { type: 'string', description: '反復実行のcron式' },
      timezone: { type: 'string', description: 'IANA timezone。既定はAsia/Tokyo' },
      prompt: { type: 'string', minLength: 1, maxLength: 8000, description: 'AIへの指示。commandと同時には指定しない。' },
      command: { type: 'string', minLength: 1, maxLength: 8000, description: 'AIを起こさずBotのプロジェクトフォルダでsh -cとして実行するコマンド。失敗した時だけユーザーへ知らせる。' },
      enabled: { type: 'boolean' },
      botId: { type: 'string', minLength: 1, description: '対象Bot ID。省略時は自分。' },
    }, ['kind']),
  },
  {
    name: 'list_schedules',
    description: 'Botの自動実行予定を一覧する。botId省略時は自分。',
    inputSchema: objectSchema({ botId: { type: 'string', minLength: 1, description: '対象Bot ID。省略時は自分。' } }),
  },
  {
    name: 'remove_schedule',
    description: 'Botの自動実行予定を削除する。botId省略時は自分。',
    inputSchema: objectSchema({
      id: { type: 'string', minLength: 1 },
      botId: { type: 'string', minLength: 1, description: '対象Bot ID。省略時は自分。' },
    }, ['id']),
  },
]

export const roomScheduleTools = [
  {
    name: 'set_room_schedule',
    description: '代表としてルームの自動実行予定を追加または更新する。',
    inputSchema: objectSchema({
      roomId: { type: 'string', minLength: 1 },
      id: { type: 'string' }, name: { type: 'string', maxLength: 100 },
      kind: { type: 'string', enum: ['once', 'cron', 'interval_days', 'interval_hours'] }, at: { type: 'string' },
      ...intervalScheduleProperties,
      expression: { type: 'string' }, timezone: { type: 'string' },
      prompt: { type: 'string', minLength: 1, maxLength: 8000 }, enabled: { type: 'boolean' },
      targets: { type: 'array', items: { type: 'string', minLength: 1 } },
    }, ['roomId', 'kind', 'prompt']),
  },
  {
    name: 'list_room_schedules',
    description: '所属ルームの自動実行予定を一覧する。',
    inputSchema: objectSchema({ roomId: { type: 'string', minLength: 1 } }, ['roomId']),
  },
  {
    name: 'remove_room_schedule',
    description: '代表としてルームの自動実行予定を削除する。',
    inputSchema: objectSchema({ roomId: { type: 'string', minLength: 1 }, id: { type: 'string', minLength: 1 } }, ['roomId', 'id']),
  },
]

export const scheduleToolHandlers = {
  async set_schedule({ registry, from, args }) {
    const { botId = from, ...schedule } = args
    return { schedule: await registry.setSchedule(botId, schedule) }
  },
  async list_schedules({ registry, from, args }) {
    return { schedules: await registry.listSchedules(args.botId ?? from) }
  },
  async remove_schedule({ registry, from, args }) {
    await registry.removeSchedule(args.botId ?? from, args.id)
    return { removed: args.id }
  },
  async set_room_schedule({ rooms, from, args }) {
    const { roomId, ...schedule } = args
    requireRepresentative(rooms, roomId, from)
    return { schedule: await rooms.setSchedule(roomId, schedule) }
  },
  async list_room_schedules({ rooms, from, args }) {
    requireRoomMember(rooms, args.roomId, from)
    return { schedules: await rooms.listSchedules(args.roomId) }
  },
  async remove_room_schedule({ rooms, from, args }) {
    requireRepresentative(rooms, args.roomId, from)
    await rooms.removeSchedule(args.roomId, args.id)
    return { removed: args.id }
  },
}
