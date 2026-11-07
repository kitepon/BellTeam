import assert from 'node:assert/strict'
import test from 'node:test'
import {containerUpdaterModels} from '../scripts/container-update-compose.mjs'
import {stateWriterPlan,assertStateWritersStopped,stateWriterSources,stateWriterVolumes} from '../src/server-state-writers.mjs'

const image='sha256:'+'a'.repeat(64)
const input=()=>({name:'selected-project',services:{bellteam:{image,environment:{SECRET:'must-stay-in-normal'},
  ports:['18891:4180'],volumes:[{type:'bind',source:'/installation/runtime/data',target:'/srv/bellteam'},
    {type:'bind',source:'/installation/runtime/home',target:'/home/bell'},
    {type:'volume',source:'cursor-cli',target:'/home/bell/.local'}]},dependency:{image:'unrelated:image'}},
  volumes:{'cursor-cli':{name:'selected-cursor'}}})

test('dedicated Docker authority, original settings preserved, idempotent and conflicting models refused',()=>{
 const normal=input(),result=containerUpdaterModels(normal),service=result.backend.services['container-updater']
 assert.deepEqual(result.normal.services.dependency,normal.services.dependency)
 assert.deepEqual(result.normal.services.bellteam.environment,normal.services.bellteam.environment)
 assert.equal(service.image,image)
 assert.equal(service.volumes.filter(m=>m.source==='/var/run/docker.sock').length,1)
 assert.equal(service.volumes.some(m=>m.target==='/srv/bellteam'||m.target==='/home/bell'),false)
 assert.equal(service.ports,undefined);assert.equal(service.environment,undefined)
 assert.equal(result.normal.services.bellteam.volumes.at(-1).read_only,true)
 assert.equal(result.normal.services.bellteam.volumes.some(m=>m.source==='/var/run/docker.sock'),false)
 assert.doesNotMatch(JSON.stringify(result.backend),/must-stay-in-normal|unrelated:image|\/installation/)
 assert.deepEqual(containerUpdaterModels(result.normal),result)
 const timed=input();timed.services.bellteam.healthcheck={interval:'10s',retries:5,start_period:'2m0s'}
 assert.equal(containerUpdaterModels(timed).normal.services.bellteam.healthcheck.start_period,'300s')
 assert.equal(result.normal.services.bellteam.stop_grace_period,'30s')
 assert.equal(normal.services.bellteam.volumes.length,3)
 for(const mutate of [n=>n.services['container-updater']={},n=>n.volumes.alias={name:'selected-project-container-updater'},
  n=>n.services.bellteam.volumes.push({type:'bind',source:'/other',target:'/run/bellteam-container-updater'}),
  n=>n.services.bellteam.image='arbitrary:tag']){
  const bad=input();mutate(bad);assert.throws(()=>containerUpdaterModels(bad),/CONTAINER_UPDATER_MODEL_INVALID/)
 }
 const legacy=input();legacy.services.bellteam.volumes.push({type:'bind',source:'/srv/bellteam/shared/tools/bellteam-container-update-host/socket',
  target:'/run/bellteam-updater',read_only:true,bind:{create_host_path:false}})
 assert.deepEqual(containerUpdaterModels(legacy),{normal:legacy,backend:null})
})

test('updater private volume and independent worker never require a data-writer exemption',()=>{
 const plan=stateWriterPlan(input())
 const containers=[{id:'updater',running:true,restarting:false,restartPolicy:'unless-stopped',mounts:[
  {Type:'volume',Name:'selected-project-container-updater',Source:'/var/lib/docker/volumes/updater/_data',RW:true},
  {Type:'bind',Source:'/var/run/docker.sock',RW:true}]},
  {id:'worker',running:true,restarting:false,restartPolicy:'no',mounts:[
   {Type:'volume',Name:'selected-project-container-updater',Source:'/var/lib/docker/volumes/updater/_data',RW:true}]}]
 const volumes=stateWriterVolumes(plan,containers).map(name=>({name,driver:'local',mountpoint:'/var/lib/docker/volumes/'+name+'/_data',optionCount:0,type:null,device:null,options:null}))
 // The daemon reports the same volume mountpoint regardless of its in-container target.
 for(const c of containers)for(const m of c.mounts)if(m.Type==='volume')m.Source=volumes.find(v=>v.name===m.Name).mountpoint
 const canonical=stateWriterSources(plan,containers,volumes).map(source=>({source,canonical:source}))
 assert.deepEqual(assertStateWritersStopped(plan,containers,canonical,volumes),{writers:0})
 containers[1].mounts.push({Type:'bind',Source:'/installation/runtime',RW:true})
 const withData=stateWriterSources(plan,containers,volumes).map(source=>({source,canonical:source}))
 assert.throws(()=>assertStateWritersStopped(plan,containers,withData,volumes),/SERVER_STATE_WRITERS_RUNNING/)
})
