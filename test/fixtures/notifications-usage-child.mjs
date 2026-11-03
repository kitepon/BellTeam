import { watch } from 'node:fs'
import { appendFile, access } from 'node:fs/promises'
import { join } from 'node:path'
import { createNotificationsChildChannel } from '../../src/notifications-ipc.mjs'
import { createNotificationsDispatcher } from '../../src/usage/notifications-dispatcher.mjs'

const root = process.argv[3]
const provider = process.argv[4] === 'provider' ? { environments: ['production'], close() {},
  async send(device, payload, id) {
    await appendFile(join(root, 'sent.jsonl'), JSON.stringify({ id, payload }) + '\n')
    if (id === 'slow') await new Promise(resolve => {
      const watcher = watch(root, () => { void access(join(root, 'release')).then(() => { watcher.close(); resolve() }, () => {}) })
      void access(join(root, 'release')).then(() => { watcher.close(); resolve() }, () => {})
    })
  } } : undefined
let channel
const dispatcher = createNotificationsDispatcher({ root, provider, diagnostic: report => channel.diagnostic(report) })
channel = createNotificationsChildChannel({ ...dispatcher,
  afterControl: async (method, value) => {
    if (method === 'initialize') await channel.ready(value)
    if (method === 'exit') await channel.close()
  },
})
