#!/usr/bin/env node
import {text} from 'node:stream/consumers'
import {pathToFileURL} from 'node:url'

// This model owns Docker access; user services and environment are never copied into it.
export function containerUpdaterModels(input) {
  const normal=structuredClone(input),service=normal?.services?.bellteam,project=normal?.name
  const fail=()=>{throw Error('CONTAINER_UPDATER_MODEL_INVALID')}
  if(typeof project!=='string'||!/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,63}$/.test(project)
    ||!service||!/^sha256:[a-f0-9]{64}$/.test(service.image??'')||!Array.isArray(service.volumes)
    ||Object.hasOwn(normal.services,'container-updater'))fail()
  const hostSocket=service.volumes.filter(m=>m.target==='/run/bellteam-updater')
  if(hostSocket.length===1&&hostSocket[0].type==='bind'&&hostSocket[0].read_only===true
    &&hostSocket[0].source==='/srv/bellteam/shared/tools/bellteam-container-update-host/socket'
    &&hostSocket[0].bind?.create_host_path===false)return {normal,backend:null}
  const socketName=project+'-container-socket',stateName=project+'-container-updater'
  const mounts=service.volumes.filter(m=>m.target==='/run/bellteam-container-updater')
  if(mounts.length){
    if(mounts.length!==1||mounts[0].type!=='volume'||mounts[0].source!=='container-socket'
      ||mounts[0].read_only!==true||mounts[0].volume?.nocopy!==true||mounts[0].volume?.subpath
      ||normal.volumes?.['container-socket']?.name!==socketName
      ||Object.keys(normal.volumes['container-socket']).join(',')!=='name')fail()
  }else{
    if(!normal.volumes||Object.hasOwn(normal.volumes,'container-socket')
      ||Object.values(normal.volumes).some(v=>[socketName,stateName].includes(v.name)))fail()
    normal.volumes['container-socket']={name:socketName}
    service.volumes.push({type:'volume',source:'container-socket',target:'/run/bellteam-container-updater',read_only:true,volume:{nocopy:true}})
  }
  const backend={name:project,services:{'container-updater':{
    image:service.image,init:true,restart:'unless-stopped',read_only:true,user:'0:0',
    entrypoint:['/usr/bin/python3','-I','-B','/app/scripts/container-update-service.py'],
    cap_drop:['ALL'],cap_add:['CHOWN','DAC_OVERRIDE','FOWNER'],security_opt:['no-new-privileges:true'],
    cpus:1,mem_limit:'2g',memswap_limit:'2g',pids_limit:512,tmpfs:['/tmp:rw,nosuid,nodev,size=64m'],
    healthcheck:{test:['CMD','/usr/bin/python3','-I','-B','/app/scripts/container-update-service.py','--health'],interval:'10s',timeout:'5s',retries:3,start_period:'120s'},
    volumes:[{type:'volume',source:'container-updater',target:'/srv/bellteam-container-updater',volume:{nocopy:true}},
      {type:'volume',source:'container-socket',target:'/run/bellteam-container-updater',volume:{nocopy:true}},
      {type:'bind',source:'/var/run/docker.sock',target:'/var/run/docker.sock',bind:{create_host_path:false}}],
  }},volumes:{'container-updater':{name:stateName},'container-socket':{name:socketName,external:true}}}
  return {normal,backend}
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href){
  try{
    const {normal,backend}=containerUpdaterModels(JSON.parse((await text(process.stdin)).replaceAll('$$','$')))
    for(const model of [normal,backend])console.log(JSON.stringify(model,(_k,v)=>typeof v==='string'?v.replaceAll('$',()=>'$$'):v))
  }catch{console.error('CONTAINER_UPDATER_MODEL_INVALID');process.exitCode=1}
}
