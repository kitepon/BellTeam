import { AsyncLocalStorage } from 'node:async_hooks'
import { createHash } from 'node:crypto'
const hash = value => createHash('sha256').update(Function.prototype.toString.call(value)).digest('hex')
const fail = () => { throw Object.assign(Error('MCP_ROOM_ADOPTION_MISMATCH'), { code: 'MCP_ROOM_ADOPTION_MISMATCH' }) }

// Only the fixed live rooms object and original cached ESM SDK class are accepted.
export function applyMcpDirectRoomBypass({ rooms, Server, expected }) {
  const sdk = Object.getOwnPropertyDescriptor(Server.prototype, 'setRequestHandler')
  const room = Object.getOwnPropertyDescriptor(rooms, 'refresh')
  if (!sdk?.configurable || !sdk.writable || !room?.configurable || !room.writable
    || typeof sdk.value !== 'function' || typeof room.value !== 'function'
    || hash(sdk.value) !== expected?.setRequestHandler || hash(room.value) !== expected?.refresh) fail()
  const scope = new AsyncLocalStorage(), marker = Object.freeze({})
  function setRequestHandler(schema, handler) {
    return Reflect.apply(sdk.value, this, [schema, function (request, ...args) {
      const direct = request.method === 'tools/call' && ['sendmessage', 'send_user_message'].includes(request.params?.name)
      return scope.run(direct ? marker : null, () => Reflect.apply(handler, this, [request, ...args]))
    }])
  }
  function refresh(...args) {
    if (scope.getStore() === marker) return Promise.resolve(rooms)
    return Reflect.apply(room.value, this, args)
  }
  Object.defineProperty(Server.prototype, 'setRequestHandler', { ...sdk, value: setRequestHandler })
  try { Object.defineProperty(rooms, 'refresh', { ...room, value: refresh }) }
  catch (error) { Object.defineProperty(Server.prototype, 'setRequestHandler', sdk); throw error }
  return { replaced: 2, directTools: ['sendmessage', 'send_user_message'], otherRoomReads: 'original' }
}
