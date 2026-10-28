import assert from 'node:assert/strict'
import fs from 'node:fs'
import {syncBuiltinESMExports} from 'node:module'
import {link, lstat, mkdir, mkdtemp, readFile, rename, rm, writeFile} from 'node:fs/promises'
import {dirname, join} from 'node:path'
import {tmpdir} from 'node:os'
import test from 'node:test'
import {transferServerState} from '../src/server-state-transfer.mjs'

const intent = paused => JSON.stringify({schema:'bellteam.ai-control.v1', paused, updatedAt:'2026-10-27T06:00:00Z'})
async function fixture(t, direction) {
  const root=await mkdtemp(join(tmpdir(),'ai-source-retention-'))
  t.after(()=>rm(root,{recursive:true,force:true}))
  for(const name of ['bots','state/bots','shared'])await mkdir(join(root,name),{recursive:true})
  const forward=direction==='to-server'
  const source=join(root,forward?'shared/ai-control.json':'state/ai-control.json')
  const target=join(root,forward?'state/ai-control.json':'shared/ai-control.json')
  const fromMarker=join(root,forward?'bots/.initialized':'state/bots/.initialized')
  const toMarker=join(root,forward?'state/bots/.initialized':'bots/.initialized')
  await writeFile(source,intent(false));await writeFile(fromMarker,'')
  return {root,source,target,fromMarker,toMarker}
}
function afterCopy(f, mutate) {
  const original=fs.promises.open
  let changed=false
  fs.promises.open=async(...args)=>{
    const file=await original(...args), sync=file.sync.bind(file)
    if(args[0]===dirname(f.target))file.sync=async()=>{await sync();if(!changed){changed=true;await mutate()}}
    return file
  }
  syncBuiltinESMExports()
  return ()=>{fs.promises.open=original;syncBuiltinESMExports()}
}
for(const mutation of ['updated','replaced'])test(`AI control source ${mutation} after copy remains with its source marker`,async t=>{
  for(const direction of ['to-server','to-legacy']){
    const f=await fixture(t,direction), value=mutation==='updated'?intent(true):intent(false)
    const restore=afterCopy(f,async()=>{
      if(mutation==='replaced')await rename(f.source,join(f.root,'held-original'))
      await writeFile(f.source,value)
    })
    let outcome
    try{outcome=await transferServerState({root:f.root,direction}).catch(e=>e)}finally{restore()}
    assert.equal(await readFile(f.source,'utf8').catch(e=>{if(e.code==='ENOENT')return null;throw e}),value)
    assert.equal(outcome.code,'SERVER_STATE_FILE_CHANGED')
    assert.equal(await readFile(f.target,'utf8'),intent(false))
    await lstat(f.fromMarker)
    await assert.rejects(lstat(f.toMarker),{code:'ENOENT'})
  }
})
test('AI control hardlink source is rejected without retiring source or creating destination',async t=>{
  for(const direction of ['to-server','to-legacy']){
    const f=await fixture(t,direction)
    await link(f.source,join(f.root,'other-link'))
    await assert.rejects(transferServerState({root:f.root,direction}),{code:'SERVER_STATE_FILE_INVALID'})
    assert.equal(await readFile(f.source,'utf8'),intent(false))
    await lstat(f.fromMarker)
    await assert.rejects(lstat(f.target),{code:'ENOENT'})
    await assert.rejects(lstat(f.toMarker),{code:'ENOENT'})
  }
})
test('unchanged AI control transfers forward and returns the latest paused intent',async t=>{
  const f=await fixture(t,'to-server')
  assert.equal((await transferServerState({root:f.root,direction:'to-server'})).status,'transferred')
  assert.equal(await readFile(f.target,'utf8'),intent(false))
  await assert.rejects(lstat(f.source),{code:'ENOENT'})
  await writeFile(f.target,intent(true))
  assert.equal((await transferServerState({root:f.root,direction:'to-legacy'})).status,'transferred')
  assert.equal(await readFile(f.source,'utf8'),intent(true))
  await assert.rejects(lstat(f.target),{code:'ENOENT'})
})
