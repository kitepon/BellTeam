import { validateConversationCallback } from './conversation/callbacks.mjs'

const fail = () => { throw Object.assign(new Error('DIRECT_LOG_RECORD_INVALID'), { code: 'DIRECT_LOG_RECORD_INVALID' }) }
const text = value => typeof value === 'string'
const id = value => text(value) && value.length > 0 && !value.includes('\0')
const object = (value, required, optional = {}) => {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || Object.keys(value).some(key => !Object.hasOwn(required, key) && !Object.hasOwn(optional, key))
    || Object.entries(required).some(([key, check]) => !Object.hasOwn(value, key) || !check(value[key]))
    || Object.entries(optional).some(([key, check]) => Object.hasOwn(value, key) && !check(value[key]))) fail()
  return true
}
const identity = value => object(value, { id, name: text, position: text, role: text })
const asset = value => object(value, { owner: id, file: id, mime: text })
const replyTo = value => object(value, { id, available: flag => typeof flag === 'boolean' },
  { sender: sender => object(sender, { id, name: text }), at: id, text, truncated: flag => flag === true, image: flag => flag === true,
    part: flag => flag === true, range: range => object(range, { start: Number.isSafeInteger, end: Number.isSafeInteger }) })
const origin = value => value?.kind === 'forward'
  ? object(value, { kind: kind => kind === 'forward', from: from => object(from, { id, name: text }), at: id, content_start: Number.isSafeInteger })
  : object(value, { kind: kind => kind === 'share', content_start: Number.isSafeInteger }, { app: text, urls: urls => Array.isArray(urls) && urls.every(text) })
const forkSeat = value => object(value, { kind: kind => kind === 'fork', fork_id: id })

export function validateDirectLogRecord(record) {
  if (record?.schema === 'bellteam.direct-message.v1') return object(record, {
    schema: value => value === 'bellteam.direct-message.v1', delivery_id: id, at: id, from: id, target: id,
    from_identity: identity, target_identity: identity, message: text, image: value => typeof value === 'boolean',
    delivery: value => ['queued', 'dispatching', 'unknown', 'running', 'steered', 'delivered', 'failed', 'stopped'].includes(value),
  }, { image_count: value => Number.isSafeInteger(value) && value > 0, image_asset: asset,
    image_assets: value => Array.isArray(value) && value.every(asset), durable_receipt: value => value === true,
    session_id: id, call_event: value => ['session.message', 'session.reply'].includes(value),
    call_seq: value => value === null || Number.isFinite(value), call_reply_required: value => typeof value === 'boolean',
    seat: forkSeat, from_seat: forkSeat, in_reply_to: id, reply_to: replyTo, origin,
    file_assets: files => Array.isArray(files) && files.every(file => object(file, { owner: id, file: id, name: text, mime: text, size: Number.isSafeInteger })),
    file_count: Number.isSafeInteger })
  if (record?.schema === 'bellteam.interim-word.v1') return object(record, {
    schema: value => value === 'bellteam.interim-word.v1', id, at: id, bot: id, group_id: id, text,
  }, { kind: value => ['error', 'answer'].includes(value), written_at: text, seat: forkSeat })
  if (record?.schema !== 'bellteam.delivery-status.v1') fail()
  object(record, { schema: value => value === 'bellteam.delivery-status.v1', delivery_id: id, at: id,
    delivery: value => ['running', 'delivered', 'failed', 'stopped'].includes(value) }, {
    mcp_error: () => true, native_launch: () => true, delivery_tracking: () => true, delivery_error: () => true, steered: () => true,
  })
  const { mcp_error, native_launch, delivery_tracking, delivery_error } = record
  validateConversationCallback('delivery.status', { delivery: record.delivery, tracking: delivery_tracking,
    ...(Object.hasOwn(record, 'steered') ? { steered: record.steered } : {}),
    error: { code: 'CONVERSATION_CALLBACK_FAILED', ...(Object.hasOwn(record, 'delivery_error') ? { delivery_error } : {}), ...(Object.hasOwn(record, 'mcp_error') ? { mcp_error } : {}), ...(Object.hasOwn(record, 'native_launch') ? { native_launch } : {}) } })
  return true
}
