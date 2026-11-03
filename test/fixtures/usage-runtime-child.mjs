import { createUsageChildChannel } from '../../src/usage/channel.mjs'
import { createUsageChannelDispatcher } from '../../src/usage/channel-dispatcher.mjs'
const [root, selected] = process.argv.slice(2)
let channel
const dispatcher = createUsageChannelDispatcher({ root, effect: (...args) => channel.effect(...args), projection: (...args) => channel.projection(...args) })
channel = createUsageChildChannel({ ...dispatcher, versionId: selected === 'builtin' ? null : selected })
