import { createUsageChildChannel } from '../../src/usage/channel.mjs'
import { createUsageChannelDispatcher } from '../../src/usage/channel-dispatcher.mjs'
let channel
const dispatcher = createUsageChannelDispatcher({ root: process.argv[2], effect: (...args) => channel.effect(...args), projection: (...args) => channel.projection(...args) })
channel = createUsageChildChannel({ ...dispatcher, versionId: null })
