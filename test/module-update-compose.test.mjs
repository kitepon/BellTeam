import assert from 'node:assert/strict'
import test from 'node:test'
import { moduleInstallerModels, moduleWorkerTerminationModel } from '../scripts/module-update-compose.mjs'

test('同image/選択private volumeを結び、normal ROと専用service RWを固定する', () => {
  const normal={name:'selected-project',services:{bellteam:{image:'sha256:'+'a'.repeat(64),volumes:[
    {type:'volume',source:'server-state',target:'/run/bellteam-maintenance',read_only:true,volume:{nocopy:true}},
  ]}},volumes:{'server-state':{name:'selected-state',external:true}}}
  const result=moduleInstallerModels(normal),service=result.backend.services['module-installer']
  assert.equal(service.image,normal.services.bellteam.image)
  assert.equal(result.backend.volumes.private.name,'selected-state')
  assert.equal(result.normal.services.bellteam.volumes.at(-1).read_only,true)
  assert.equal(service.volumes.find(v=>v.source==='private').read_only,undefined)
  assert.deepEqual(service.entrypoint,['/usr/bin/python3','-I','-B','/app/scripts/module-update-service.py'])
  assert.deepEqual(service.cap_drop,['ALL'])
  assert.equal(service.volumes.some(v=>v.type==='bind'),false)
  assert.equal(normal.services.bellteam.volumes.length,1)
  assert.deepEqual(moduleInstallerModels(result.normal).normal,result.normal)
  const bad=structuredClone(normal);bad.services.bellteam.volumes[0].read_only=false
  assert.throws(()=>moduleInstallerModels(bad),/MODULE_INSTALLER_MODEL_INVALID/)
  const extra=structuredClone(normal);extra.services.sidecar={image:'another:image',environment:{SECRET:'sidecar-only'}}
  assert.deepEqual(moduleInstallerModels(extra).normal.services.sidecar,extra.services.sidecar)
  assert.doesNotMatch(JSON.stringify(moduleInstallerModels(extra).backend),/sidecar-only|another:image/)
  extra.services['module-installer']={image:'conflicting:image'}
  assert.throws(()=>moduleInstallerModels(extra),/MODULE_INSTALLER_MODEL_INVALID/)
})


test('termination helper alone owns temporary Docker access and pins the same project/image/volumes',()=>{
 const input={name:'selected-project',services:{bellteam:{image:'sha256:'+'a'.repeat(64),environment:{SECRET:'private'},volumes:[
  {type:'bind',source:'/selected/runtime/data',target:'/srv/bellteam'},
  {type:'bind',source:'/selected/runtime/home',target:'/home/bell'},
  {type:'volume',source:'state',target:'/run/bellteam-maintenance',read_only:true,volume:{nocopy:true}}]},sidecar:{image:'other'}},volumes:{state:{name:'selected-state',external:true}}}
 const result=moduleWorkerTerminationModel(input),helper=result.services['module-worker-termination']
 assert.deepEqual(helper.entrypoint,['/usr/bin/python3','-I','-B','/app/scripts/module-worker-termination.py'])
 assert.deepEqual(helper.command,['selected-project',input.services.bellteam.image,'selected-state','/selected/runtime/server-only/state-data'])
 assert.equal(helper.volumes.some(m=>m.target==='/run/bellteam-updater'),false)
 assert.equal(helper.volumes.filter(m=>m.type==='bind').length,1)
 assert.equal(helper.volumes.find(m=>m.type==='bind').bind.create_host_path,false)
 assert.equal(helper.restart,undefined);assert.equal(helper.healthcheck,undefined)
 assert.doesNotMatch(JSON.stringify(result),/SECRET|sidecar|other/)
 const bad=structuredClone(input);bad.services.bellteam.volumes[1].source='/other/home'
 assert.throws(()=>moduleWorkerTerminationModel(bad),/MODULE_INSTALLER_MODEL_INVALID/)
 const conflicting=structuredClone(input);conflicting.services['module-worker-termination']={image:'other'}
 assert.throws(()=>moduleWorkerTerminationModel(conflicting),/MODULE_INSTALLER_MODEL_INVALID/)
})

test('Z-b2 runtime-code: body reads it, the module-installer alone writes it, termination never mounts it', () => {
  const root = '/srv/bellteam/shared/tools/bellteam-runtime'
  const normal={name:'p',services:{bellteam:{image:'sha256:'+'a'.repeat(64),volumes:[
    {type:'bind',source:'/r/data',target:'/srv/bellteam'},{type:'bind',source:'/r/home',target:'/home/bell'},
    {type:'volume',source:'server-state',target:'/run/bellteam-maintenance',read_only:true,volume:{nocopy:true}}]}},
    volumes:{'server-state':{name:'s',external:true}}}
  const {normal:body,backend}=moduleInstallerModels(normal)
  assert.deepEqual(body.services.bellteam.volumes.filter(m=>m.target===root),[{type:'volume',source:'runtime-code',target:root,read_only:true}])
  assert.equal(body.volumes['runtime-code'].name,'p-runtime-code')
  assert.equal(backend.services['module-installer'].volumes.find(m=>m.target===root).read_only,undefined)
  assert.deepEqual(backend.volumes['runtime-code'],{name:'p-runtime-code',external:true})
  assert.deepEqual(moduleInstallerModels(body).normal,body)
  const writable=structuredClone(body);writable.services.bellteam.volumes.find(m=>m.target===root).read_only=false
  assert.throws(()=>moduleInstallerModels(writable),/MODULE_INSTALLER_MODEL_INVALID/)
  const helper=moduleWorkerTerminationModel(normal).services['module-worker-termination']
  assert.equal(helper.volumes.some(m=>m.source==='runtime-code'),false)
})

test('module-installer reads the body update channel and nothing else of its environment', () => {
  const normal = channel => ({name:'p',services:{bellteam:{image:'sha256:'+'a'.repeat(64),
    environment:{SECRET:'body-only',...(channel === undefined ? {} : {BELLTEAM_UPDATE_CHANNEL:channel})},volumes:[
    {type:'volume',source:'server-state',target:'/run/bellteam-maintenance',read_only:true,volume:{nocopy:true}}]}},
    volumes:{'server-state':{name:'s',external:true}}})
  const installer = channel => moduleInstallerModels(normal(channel)).backend.services['module-installer']
  assert.deepEqual(installer('candidate').environment,{BELLTEAM_UPDATE_CHANNEL:'candidate'})
  assert.deepEqual(installer('stable').environment,{BELLTEAM_UPDATE_CHANNEL:'stable'})
  assert.equal(installer(undefined).environment,undefined)
  assert.throws(()=>installer('nightly'),/MODULE_INSTALLER_MODEL_INVALID/)
  assert.doesNotMatch(JSON.stringify(moduleInstallerModels(normal('candidate')).backend),/body-only/)
})
