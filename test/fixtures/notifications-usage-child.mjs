import { watch } from 'node:fs'
import { appendFile, access } from 'node:fs/promises'
import { join } from 'node:path'
import { createNotificationsChildChannel } from '../../src/notifications-ipc.mjs'
import { createNotificationsDispatcher } from '../../src/usage/notifications-dispatcher.mjs'

const root = process.argv[3]
const mode = process.argv[4]
const waitRelease = name => new Promise(resolve => {
  const watcher = watch(root, () => { void access(join(root, name)).then(() => { watcher.close(); resolve() }, () => {}) })
  void access(join(root, name)).then(() => { watcher.close(); resolve() }, () => {})
})
const provider = ['provider', 'both-providers', 'receipt-provider'].includes(mode) ? { environments: ['production'], close() {},
  async send(device, payload, id) {
    await appendFile(join(root, 'sent.jsonl'), JSON.stringify({ id, payload }) + '\n')
    if (id === 'slow' || mode === 'receipt-provider') await waitRelease('release')
    if (mode === 'receipt-provider') return { apnsStatus: 200, apnsId: '11111111-2222-3333-4444-555555555555' }
  } } : undefined
const webPushProvider = mode === 'both-providers' ? { async send(_subscription, payload) {
  await appendFile(join(root, 'web-sent.jsonl'), payload + '\n')
  await waitRelease('web-release')
} } : undefined
let channel
const dispatcher = createNotificationsDispatcher({ root, provider, webPushProvider, diagnostic: report => channel.diagnostic(report) })
channel = createNotificationsChildChannel({ ...dispatcher,
  afterControl: async (method, value) => {
    if (method === 'initialize') await channel.ready(value)
    if (method === 'exit') await channel.close()
  },
})
