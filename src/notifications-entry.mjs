import { createNotificationsChildChannel, verifyNotificationsLocks } from './notifications-ipc.mjs'
import { createNotificationsDispatcher } from './usage/notifications-dispatcher.mjs'

verifyNotificationsLocks()
let channel
const dispatcher = createNotificationsDispatcher({ root: '/srv/bellteam', diagnostic: report => channel.diagnostic(report) })
channel = createNotificationsChildChannel({
  validateRequest: dispatcher.validateRequest,
  dispatch: dispatcher.dispatch,
  control: dispatcher.control,
  disconnect: dispatcher.disconnect,
  afterControl: async (method, value) => {
    if (method === 'initialize') await channel.ready(value)
    if (method === 'exit') await channel.close()
  },
})
