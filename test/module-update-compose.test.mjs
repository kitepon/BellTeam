import assert from 'node:assert/strict'
import test from 'node:test'
import { moduleInstallerModels } from '../scripts/module-update-compose.mjs'

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
