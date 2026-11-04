#!/usr/bin/env node
import { text } from 'node:stream/consumers'

// The installer supplies its frozen normal model, never a caller-selected service.
export function moduleInstallerModels(input) {
  const normal = structuredClone(input), service = normal?.services?.bellteam
  const project = normal?.name
  if (typeof project !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,63}$/.test(project ?? '') || !service
    || Object.keys(normal.services).join(',') !== 'bellteam'
    || typeof service.image !== 'string' || !/^sha256:[a-f0-9]{64}$/.test(service.image ?? '') || !Array.isArray(service.volumes)) throw Error('MODULE_INSTALLER_MODEL_INVALID')
  const control = service.volumes.filter(m => m.target === '/run/bellteam-maintenance')
  if (control.length !== 1 || control[0].type !== 'volume' || control[0].read_only !== true
    || control[0].volume?.nocopy !== true || control[0].volume?.subpath
    || normal.volumes?.[control[0].source]?.external !== true) throw Error('MODULE_INSTALLER_MODEL_INVALID')
  const privateName = normal.volumes[control[0].source].name
  if (typeof privateName !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/.test(privateName)) throw Error('MODULE_INSTALLER_MODEL_INVALID')
  const socketName = project + '-module-socket', stateName = project + '-module-updater'
  const sockets = service.volumes.filter(m => m.target === '/run/bellteam-updater')
  if (sockets.length === 1 && sockets[0].type === 'bind' && sockets[0].read_only === true
    && sockets[0].source === '/srv/bellteam/shared/tools/bellteam-container-update-host/socket'
    && sockets[0].bind?.create_host_path === false) return {normal,backend:null}
  if (sockets.length) {
    if (sockets.length !== 1 || sockets[0].type !== 'volume' || sockets[0].source !== 'module-socket'
      || sockets[0].read_only !== true || sockets[0].volume?.nocopy !== true || sockets[0].volume?.subpath
      || normal.volumes?.['module-socket']?.name !== socketName) throw Error('MODULE_INSTALLER_MODEL_INVALID')
  } else {
    if (Object.values(normal.volumes).some(v => [socketName, stateName].includes(v.name))) throw Error('MODULE_INSTALLER_MODEL_INVALID')
    normal.volumes['module-socket'] = { name:socketName }
    service.volumes.push({ type:'volume',source:'module-socket',target:'/run/bellteam-updater',read_only:true,volume:{nocopy:true} })
  }
  const backend = { name:project, services:{ 'module-installer': {
    image:service.image,init:true,restart:'unless-stopped',read_only:true,user:'0:0',
    entrypoint:['/usr/bin/python3','-I','-B','/app/scripts/module-update-service.py'],
    cap_drop:['ALL'],cap_add:['CHOWN','DAC_OVERRIDE','FOWNER'],security_opt:['no-new-privileges:true'],
    cpus:1,mem_limit:'2g',memswap_limit:'2g',pids_limit:512,
    tmpfs:['/tmp:rw,nosuid,nodev,size=64m'],
    healthcheck:{test:['CMD','/usr/bin/python3','-I','-B','/app/scripts/module-update-service.py','--health'],interval:'10s',timeout:'5s',retries:3,start_period:'120s'},
    volumes:[{type:'volume',source:'module-updater',target:'/srv/bellteam-module-updater',volume:{nocopy:true}},
      {type:'volume',source:'module-socket',target:'/run/bellteam-updater',volume:{nocopy:true}},
      {type:'volume',source:'private',target:'/srv/bellteam-private',volume:{nocopy:true}}],
  } },volumes:{'module-updater':{name:stateName},'module-socket':{name:socketName,external:true},private:{name:privateName,external:true}} }
  return {normal,backend}
}

if (process.argv[1] && import.meta.url === (await import('node:url')).pathToFileURL(process.argv[1]).href) {
  try {
    const input = JSON.parse((await text(process.stdin)).replaceAll('$$','$'))
    const {normal,backend} = moduleInstallerModels(input)
    for (const model of [normal,backend]) console.log(JSON.stringify(model,(_key,value)=>typeof value==='string'?value.replaceAll('$',()=> '$$'):value))
  } catch { console.error('MODULE_INSTALLER_MODEL_INVALID');process.exitCode=1 }
}
