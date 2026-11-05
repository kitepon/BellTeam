import test from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { createExecutionGeneration } from '../src/execution-generation.mjs'
import { createExecutionDispatcher } from '../src/execution-dispatcher.mjs'
import { MembersAdmission } from '../src/members-admission.mjs'
const output = '/srv/bellteam/bots/bot-09e6225c/integrations/j-execution-busy-20261105'
const delivery = '11111111-1111-4111-8111-111111111111'
for (const capacity of [false, true]) test(`proof waits actual native terminal or rejects deferred recovery: capacity=${capacity}`, async () => {
 let nativeClosed = false, earlyProofCalls = null, proofAt = null, closedAt = null
 const root = await mkdtemp(join(output, 'local-fixture-'))
 const bot = { id: 'bot-synthetic', session: 'bot-synthetic', harness: 'codex', project: root }
 const bots = new Map([[bot.id, bot]]); bots.refresh = async () => {}
 let authCalls = 0, proofCalls = 0
 const ports = { bots, rooms: {}, membersAdmission: new MembersAdmission(),
 configurationStorage: { root: join(root, 'intents'), ownerUid: process.getuid() }, access: { assertWorkAllowed() {} },
 observer: { report() {} }, diagnostics: { record() {} },
 continuation: { models: {}, messenger: {}, harnessAuth: { status: async () => { authCalls++; return { status: 'unauthenticated' } } } },
 seat: { waitProcess: () => new Promise((resolve, reject) => {
   const result = capacity ? { schema: 'aiterm.agent-wait-result.v1', outcome: 'error', error: 'synthetic capacity', vendor: 'codex', session_id: bot.session, launch_id: 'a'.repeat(32), operation_id: null, turn_id: 'turn', failure: { category: 'capacity', execution: 'unknown', terminal: true, future_effects: 'unknown', boundary: { event_cursor: 1, operation_id: null, turn_id: 'turn' } } } : { outcome: 'done', turn_id: 'turn' }
   const child = spawn(process.execPath, ['-e', 'setTimeout(()=>process.exit(0),200)'], { stdio: 'ignore', env: {} })

   child.once('error', reject); child.once('close', code => { nativeClosed = true; closedAt = performance.now(); resolve(result) })
 }) },
 native: { async call(name) {
 if (name === 'pty_list') return { content: [{type:'text',text:`${bot.session}\tstub`}] }
 if (name === 'pty_observe') return { structuredContent: {exists:true,state:'idle'} }
 if (name === 'pty_send') return { structuredContent: {mode:'agent_dispatch',session_id:bot.session,vendor:'codex',launch_id:'a'.repeat(32),event_cursor:1,wait_process:{executable:'stub',args:[]}} }
 if (name === 'pty_read') return { structuredContent: {schema:'aiterm.pty-read-result.v1',mode:'agent_transcript',text:'',turn_id:'turn'} }
 throw Error(`unexpected native method ${name}`)
 }, async close() {} } }
 const controller = createExecutionGeneration({ ports, loadFactory: async versionId => Object.freeze({versionId,sourceCommit:'421d2a9f3a900cd73991d86511307d2e596a3711',createExecutionDispatcher}), onAdopt: async () => {} })
 try {
 await controller.start()
 await controller.dispatch({method:'transport.notify',args:[bot,'synthetic',{queue:{groupId:delivery}}]})
 const started = performance.now()
 const proof = controller.withInstallReconciliationProof(() => { assert.equal(nativeClosed,true); proofAt=performance.now(); proofCalls++; return 'proved' })
 await new Promise(resolve=>setTimeout(resolve,50)); earlyProofCalls=proofCalls; assert.equal(nativeClosed,false); assert.equal(earlyProofCalls,0)
 if (capacity) await assert.rejects(proof, {code:'EXECUTION_BUSY'}); else assert.equal(await proof, 'proved')
 const elapsed = performance.now()-started
 await new Promise(resolve=>setImmediate(resolve))
 assert.equal(proofCalls,capacity ? 0 : 1)
 assert.ok(elapsed<2000, 'deferred recovery must not wait for the 60-second deadline')
 assert.equal(nativeClosed,true)
 if (capacity) assert.ok(authCalls>0, 'original intent recovered by existing resume')
 else assert.ok(proofAt>=closedAt)
 assert.equal(controller.snapshot().available,true)
 await controller.close()
 await writeFile(join(output,`repair-${capacity?'capacity':'success'}.json`), JSON.stringify({capacity,elapsed,proofCalls,authCalls,earlyProofCalls,nativeClosed,closedAt,proofAt},null,2)+'\n')
 } finally { await rm(root,{recursive:true,force:true}) }
})
