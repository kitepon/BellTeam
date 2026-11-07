import assert from 'node:assert/strict'
import { once } from 'node:events'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { BotRegistry } from '../src/bot-registry.mjs'
import { avatarVersion, createBellTeamServer } from '../src/http-server.mjs'
import { callBellTeamTool } from '../src/mcp-tools.mjs'

const image = value => `data:image/png;base64,${Buffer.from(value).toString('base64')}`
const small=image('small'), large=image('large'), source=image('original'), crop={x:0.1,y:0.2,width:0.5,height:0.6}

test('avatar variants survive reload and unrelated edits, with legacy render-only changes clearing stale crops', async t => {
  const root=await mkdtemp(join(tmpdir(),'bellteam-avatar-'));t.after(()=>rm(root,{recursive:true,force:true}))
  const seedPath=join(root,'seed.json'),botsRoot=join(root,'bots')
  await writeFile(seedPath,JSON.stringify({schema:'bellteam.bots.v1',bots:[{
    id:'bot-a',displayName:'A',harness:'grok',color:'rose',session:'bot-a',project:'/old/path'}]}))
  const registry=new BotRegistry({seedPath,botsRoot});await registry.initialize()
  await registry.update('bot-a',{avatar:small,avatarSource:source,avatarCrop:crop,
    avatarLarge:large,avatarLargeSource:source,avatarLargeCrop:crop})
  await registry.update('bot-a',{role:'same pictures'})
  const reloaded=new BotRegistry({seedPath,botsRoot});await reloaded.initialize()
  assert.deepEqual(reloaded.get('bot-a').avatarCrop,crop)
  assert.equal(reloaded.get('bot-a').avatarLargeSource,source)
  assert.equal(JSON.parse(await readFile(join(botsRoot,'bot-a/bot.json'),'utf8')).avatarLarge,large)
  await reloaded.update('bot-a',{avatar:image('replacement')})
  assert.equal(reloaded.get('bot-a').avatarSource,'');assert.equal(reloaded.get('bot-a').avatarCrop,null)
  assert.equal(reloaded.get('bot-a').avatarLarge,large)
  assert.deepEqual(reloaded.get('bot-a').avatarLargeCrop,crop)
  for(const invalid of [{...crop,x:0.9},{...crop,width:0},{...crop,x:NaN},{...crop,extra:1}])
    await assert.rejects(reloaded.update('bot-a',{avatar:small,avatarSource:source,avatarCrop:invalid}),/INVALID/)
  await assert.rejects(reloaded.update('bot-a',{avatarCrop:crop}),/INVALID/)
  await assert.rejects(reloaded.update('bot-a',{avatarSource:'x'.repeat(3_000_001),avatarCrop:crop,avatar:small}),/INVALID/)
})

test('avatar variants use authenticated versioned detail images and omit source bodies from list and MCP', async t => {
  const bot={id:'bot-a',name:'A',avatar:small,avatarLarge:large,avatarSource:source,avatarLargeSource:source,
    avatarCrop:crop,avatarLargeCrop:crop}
  const bots=new Map([[bot.id,bot],['bot-old',{id:'bot-old',avatar:small}]])
  bots.refresh=async()=>{}
  const server=createBellTeamServer({bots,authorize:r=>r.headers.authorization==='test',messenger:{},
    store:{async timeline(){return[]}},transport:{async runningBots(){return new Set()}}})
  server.listen(0,'127.0.0.1');await once(server,'listening');t.after(()=>server.close())
  const base=`http://127.0.0.1:${server.address().port}`,headers={authorization:'test'}
  const list=await(await fetch(base+'/api/bots?avatar=omit',{headers})).json()
  assert.equal(list.bots[0].avatarLargeVersion,avatarVersion(large))
  assert.equal(list.bots[1].avatarLargeVersion,avatarVersion(small))
  for(const field of ['avatar','avatarLarge','avatarSource','avatarLargeSource'])assert.equal(list.bots[0][field],'')
  assert.deepEqual(list.bots[0].avatarCrop,crop)
  const detail=await(await fetch(base+'/api/bots/bot-a',{headers})).json()
  assert.equal(detail.bot.avatarSource,source);assert.equal(detail.bot.avatarLarge,large)
  for(const [suffix,value] of [['avatar-large',large],['avatar-source',source],['avatar-large-source',source]]){
    const path='/api/bots/bot-a/'+suffix
    assert.equal((await fetch(base+path)).status,401)
    const r=await fetch(base+path+'?v='+avatarVersion(value),{headers})
    assert.equal(r.status,200);assert.equal(r.headers.get('etag'),`"${avatarVersion(value)}"`)
    assert.deepEqual(Buffer.from(await r.arrayBuffer()),Buffer.from(value.split(',')[1],'base64'))
    assert.equal((await fetch(base+path,{headers:{...headers,'if-none-match':`"${avatarVersion(value)}"`}})).status,304)
  }
  const fallback=await fetch(base+'/api/bots/bot-old/avatar-large',{headers})
  assert.equal(fallback.status,200);assert.equal(fallback.headers.get('etag'),`"${avatarVersion(small)}"`)
  assert.equal((await fetch(base+'/api/bots/bot-old/avatar-source',{headers})).status,404)
  const result=await callBellTeamTool({name:'get_self',arguments:{},registry:bots,from:bot.id,internalUrl:'http://127.0.0.1:4181'})
  for(const field of ['avatar','avatarLarge','avatarSource','avatarLargeSource'])assert.equal(result.bot[field],undefined)
})
