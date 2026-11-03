import { verifyUsageLocks } from './usage-locks.mjs'
import { createUsageChildChannel } from './usage/channel.mjs'
import { createUsageChannelDispatcher } from './usage/channel-dispatcher.mjs'

try {
  if (process.argv.length !== 3 || !['builtin'].includes(process.argv[2]) && !/^[a-f0-9]{64}$/.test(process.argv[2])) throw new Error('USAGE_ENTRY_INVALID')
  verifyUsageLocks()
  let channel
  const dispatcher = createUsageChannelDispatcher({ root: '/srv/bellteam',
    effect: (...args) => channel.effect(...args), projection: (...args) => channel.projection(...args) })
  channel = createUsageChildChannel({ ...dispatcher })
} catch {
  process.stderr.write('USAGE_START_FAILED\n')
  process.exitCode = 1
  if (process.connected) process.disconnect()
}
