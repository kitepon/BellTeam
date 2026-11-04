#!/usr/bin/env node
import {lstat,open} from 'node:fs/promises'
import {constants} from 'node:fs'
import {posix} from 'node:path'
import {pathToFileURL} from 'node:url'
import {text} from 'node:stream/consumers'

export function containerUpdateSavedPath(volume,project,working,file){
  const fail=()=>{throw Error('SERVER_STATE_PREVIOUS_MODEL_UNVERIFIED')}
  if(typeof project!=='string'||!/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,63}$/.test(project)
    ||volume?.Name!==project+'-container-updater'||volume.Driver!=='local'
    ||volume.Options!==null&&(typeof volume.Options!=='object'||Array.isArray(volume.Options)||Object.keys(volume.Options).length)
    ||volume.Labels?.['com.docker.compose.project']!==project||volume.Labels?.['com.docker.compose.volume']!=='container-updater'
    ||typeof volume.Mountpoint!=='string'||!/^\/[A-Za-z0-9/._-]+$/.test(volume.Mountpoint)
    ||posix.normalize(volume.Mountpoint)!==volume.Mountpoint)fail()
  const root=volume.Mountpoint+'/installation/work'
  if(working!==root||typeof file!=='string'||posix.normalize(file)!==file
    ||!/^\.bellteam-compose\.[a-zA-Z0-9]{6}$/.test(posix.basename(posix.dirname(file)))
    ||posix.dirname(posix.dirname(file))!==root||!['normal.json','previous-normal.json'].includes(posix.basename(file)))fail()
  return posix.relative(volume.Mountpoint,file)
}

if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href){
  try{
    const relative=containerUpdateSavedPath(JSON.parse(await text(process.stdin)),...process.argv.slice(2))
    let path='/updater'
    for(const part of relative.split('/')){
      const info=await lstat(path)
      if(!info.isDirectory()||info.uid!==0||info.mode&0o22)throw Error()
      path=posix.join(path,part)
    }
    const file=await open(path,constants.O_RDONLY|constants.O_NOFOLLOW|constants.O_NONBLOCK)
    try{
      const info=await file.stat()
      if(!info.isFile()||info.uid!==0||info.nlink!==1||info.mode&0o22||info.size>1024*1024)throw Error()
      const raw=await file.readFile();if(raw.length>1024*1024)throw Error()
      JSON.parse(raw);process.stdout.write(raw)
    }finally{await file.close()}
  }catch{console.error('SERVER_STATE_PREVIOUS_MODEL_UNVERIFIED');process.exitCode=1}
}
