import { readFile, writeFile } from 'node:fs/promises'
import { createNotificationsChildChannel } from '../../src/notifications-ipc.mjs'
const mode = process.argv[3]
let config = {}, channel, resumes = 0
const status = { apns: { configured: false, environments: [] }, webPush: { enabled: false, configured: false, publicKey: null, error: null } }
const initialized = () => ({ status, applyError: { apns: null, webPush: null } })
channel = createNotificationsChildChannel({
  validateRequest() {},
  async dispatch(method, params) {
    if (params.crash) process.exit(7)
    if (params.delay) await new Promise(resolve => setTimeout(resolve, params.delay))
    if (method === 'register') { const {provider,...saved}=params; if (process.argv[4]) await writeFile(process.argv[4] + '/state/push-devices.json', JSON.stringify([saved])); return { registered: true } }
    if (method === 'unregister') return { registered: false }
    if (method === 'publish') return { accepted: true }
    if (method === 'configure') { if (mode === 'configure-delay') await new Promise(resolve => setTimeout(resolve, 100)); config[params.provider] = params }
    if (params.diagnostic) await channel.diagnostic({code:'SERVER_PUSH_SEND_FAILED',module:'notifications',diagnostic_log:'FIXTURE_ERROR'})
    return status[params.provider]
  },
  async control(method, params) {
    if (method === 'initialize') {
      if (mode === 'hang-initialize') await new Promise(() => {})
      if (mode === 'bad-initialize') throw Object.assign(new Error(), {code:'PUSH_FIXTURE_FAILURE'})
      config = params.configuration
      if (config.apns.relayUrl === 'hang-initialize') await new Promise(() => {})
      if (config.apns.relayUrl === 'bad-ready') return initialized()
    }
    if (method === 'resume' && ++resumes > 1 && mode === 'hang-resume') await new Promise(() => {})
    if (method === 'quiesce' && mode === 'hang-quiesce') await new Promise(() => {})
    if (method === 'exit' && mode === 'hang-exit') await new Promise(() => {})
    return method === 'initialize' ? initialized()
      : method === 'quiesce' ? {quiesced:true} : method === 'resume' ? {resumed:true} : {closed:true}
  },
  async afterControl(method,value) { if (method === 'initialize') await channel.ready(value); if (method === 'exit') await channel.close() },
  async disconnect() {},
})
