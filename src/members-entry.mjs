import { createMembersChildChannel, verifyMembersLocks } from './members-ipc.mjs'
import { createMembersDispatcher } from './members/dispatcher.mjs'

try {
  verifyMembersLocks()
  let channel
  const dispatcher = createMembersDispatcher({ root: '/srv/bellteam',
    effect: (...args) => channel.effect(...args), projection: (...args) => channel.projection(...args),
    diagnostic: report => channel.diagnostic(report) })
  channel = createMembersChildChannel({ ...dispatcher, afterControl: async method => {
    if (method === 'initialize') await channel.ready()
    if (method === 'exit') await channel.close()
  } })
} catch {
  process.stderr.write('MEMBERS_START_FAILED\n')
  process.exitCode = 1
  if (process.connected) process.disconnect()
}
