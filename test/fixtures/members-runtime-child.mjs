import { createMembersChildChannel } from '../../src/members-ipc.mjs'
import { createMembersDispatcher } from '../../src/members/dispatcher.mjs'

let channel
const dispatcher = createMembersDispatcher({ root: process.argv[3], effect: (...args) => channel.effect(...args),
  projection: (...args) => channel.projection(...args), diagnostic: report => channel.diagnostic(report) })
channel = createMembersChildChannel({ ...dispatcher, control: (method, params, context) => {
  if (process.argv[4] === 'bad-initialize' && method === 'initialize') throw Object.assign(new Error(), { code: 'MEMBERS_FIXTURE_INITIALIZE_FAILED' })
  if (process.argv[4] === 'hang-quiesce' && method === 'quiesce') return new Promise(() => {})
  if (process.argv[4] === 'hang-initialize' && method === 'initialize') return new Promise(() => {})
  if (process.argv[4] === 'hang-exit' && method === 'exit') return new Promise(() => {})
  return dispatcher.control(method, params, context)
}, afterControl: async method => {
  if (method === 'initialize') await channel.ready()
  if (method === 'exit') await channel.close()
} })
