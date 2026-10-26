import assert from 'node:assert/strict'
import {readFile, lstat, mkdir, readdir} from 'node:fs/promises'
import {createHash} from 'node:crypto'
import {hostname} from 'node:os'
import {bugHubSecurityTools as baseline} from './base-module.mjs'
import {bugHubSecurityTools as actual} from '/app/src/bughub-security.mjs'

const expected=JSON.parse(await readFile(new URL('./expected.json',import.meta.url),'utf8'))
const raw=await readFile('/app/src/bughub-security.mjs')
const hash=createHash('sha256').update(raw).digest('hex')
assert.equal(hash,expected.moduleSHA256)
const metadata={}
for(const path of ['app','app/src','app/src/bughub-security.mjs']){
  const info=await lstat('/'+path)
  assert.ok(path.endsWith('.mjs')?info.isFile():info.isDirectory())
  metadata[path]={uid:info.uid,gid:info.gid,mode:info.mode&0o7777}
}
if(expected.patched){
  assert.equal(createHash('sha256').update(expected.metadataBindingRaw).digest('hex'),expected.metadataBindingSHA256)
  assert.deepEqual(metadata,JSON.parse(expected.metadataBindingRaw).metadata)
}
for(const path of ['/tmp/empty-home','/tmp/empty-docker-config']){
  await mkdir(path,{mode:0o700})
  assert.deepEqual(await readdir(path),[])
}
const env=Object.fromEntries(expected.baseEnv.map(x=>[x.slice(0,x.indexOf('=')),x.slice(x.indexOf('=')+1)]))
env.HOME='/tmp/empty-home'
env.DOCKER_CONFIG='/tmp/empty-docker-config'
assert.match(process.env.HOSTNAME,/^[a-f0-9]{12}$/)
assert.equal(process.env.HOSTNAME,hostname())
env.HOSTNAME=hostname()
assert.deepEqual({...process.env},env)
assert.ok(Object.keys(env).every(key=>!/TOKEN|SECRET|PASSWORD|CREDENTIAL|API_KEY/i.test(key)))
function strip(value){
  if(Array.isArray(value))return value.map(strip)
  if(value&&typeof value==='object')return Object.fromEntries(Object.entries(value).filter(([key])=>key!=='description').map(([key,value])=>[key,strip(value)]))
  return value
}
assert.deepEqual(strip(actual),strip(baseline))
if(expected.patched){
  for(const name of ['bughub_create_security_finding','bughub_update_security_finding']){
    const tool=actual.find(x=>x.name===name)
    const fields=name.includes('update')?tool.inputSchema.properties.patch.properties:tool.inputSchema.properties
    for(const [key,limit] of Object.entries({target:160,title:500,summary:4000}))assert.ok(fields[key].description.includes(`最大${limit}文字`))
    assert.ok(fields.target.description.includes('複数対象の一覧は summary'))
    assert.ok(fields.summary.description.includes('複数対象の一覧はここ'))
  }
}else assert.deepEqual(actual,baseline)
console.log(JSON.stringify({stage:'bughub-metadata-only',patched:expected.patched,moduleSHA256:hash,metadata,serviceCalls:0}))
