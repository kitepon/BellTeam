import { readFile, writeFile } from 'node:fs/promises'
import { createNotificationsChildChannel } from '../../src/notifications-ipc.mjs'
const mode = process.argv[3]
let saved = {}, config = {}, channel, resumes = 0
channel = createNotificationsChildChannel({
  validateRequest() {},
  async dispatch(method, params) {
    if (params.crash) process.exit(7)
    if (params.delay) await new Promise(resolve => setTimeout(resolve, params.delay))
    if (method === 'register') { saved = params; if (process.argv[4]) await writeFile(process.argv[4] + '/state/push-devices.json', JSON.stringify([params])); return { registered: true } }
    if (method === 'unregister') return { registered: false }
    if (method === 'publish') return { accepted: true }
    if (method === 'configure') config = params
    if (params.diagnostic) await channel.diagnostic({code:'SERVER_PUSH_SEND_FAILED',module:'notifications',diagnostic_log:'FIXTURE_ERROR'})
    return { configured: false, environments: [] }
  },
  async control(method, params) {
    if (method === 'initialize') {
      if (mode === 'hang-initialize') await new Promise(() => {})
      if (mode === 'bad-initialize') throw Object.assign(new Error(), {code:'PUSH_FIXTURE_FAILURE'})
      config = params.configuration
      if (config.relayUrl === 'hang-initialize') await new Promise(() => {})
      if (config.relayUrl === 'bad-ready') return {status:{configured:false,environments:[]},applyError:null}
      await channel.ready({status:{configured:false,environments:[]}})
    }
    if (method === 'resume' && ++resumes > 1 && mode === 'hang-resume') await new Promise(() => {})
    if (method === 'quiesce' && mode === 'hang-quiesce') await new Promise(() => {})
    if (method === 'exit' && mode === 'hang-exit') await new Promise(() => {})
    return method === 'initialize' ? {status:{configured:false,environments:[]},applyError:null}
      : method === 'quiesce' ? {quiesced:true} : method === 'resume' ? {resumed:true} : {closed:true}
  },
  async afterControl(method) { if (method === 'exit') channel.close() },
  async disconnect() {},
})
