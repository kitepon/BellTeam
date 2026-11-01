import assert from 'node:assert/strict'
import test from 'node:test'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { mkdtemp, mkdir, chmod, writeFile, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const exec = promisify(execFile)
const fakeDocker = String.raw`
const fs=require('node:fs'),cp=require('node:child_process'),a=process.argv.slice(2),e=process.env;
const out=v=>console.log(typeof v==='string'?v:JSON.stringify(v));
if(a[0]==='compose'){out(a.includes('--images')?'fixture':JSON.parse(e.TEST_CONFIG));process.exit(0)}
if(a[0]==='image'){out('sha256:'+'a'.repeat(64));process.exit(0)}
if(a[0]==='ps'){if(JSON.parse(e.TEST_CONTAINERS).length)out('c'.repeat(64));process.exit(0)}
if(a[0]==='inspect'){for(const c of JSON.parse(e.TEST_CONTAINERS))out(c);process.exit(0)}
if(a[0]==='volume'){
 const record=JSON.parse(e.TEST_VOLUMES).find(v=>v.name===a.at(-1));
 if(!record)process.exit(43);out(record);process.exit(0)
}
if(a[0]==='run'){
 const mount=a[a.indexOf('--mount')+1];let file=e.TEST_SOURCE;
 if(a.includes('--mount')){
  const dir=mount.match(/^type=bind,source=(.+),target=\/check,readonly$/)?.[1];
  if(!dir)throw Error('reader mount must contain only evidence');
  file=e.TEST_ROOT+'/reader.mjs';fs.writeFileSync(file,fs.readFileSync(e.TEST_SOURCE,'utf8').replaceAll('/check/',dir+'/'));
 }
 const r=cp.spawnSync(process.execPath,[file,a.at(-1)],{input:a.includes('-i')?fs.readFileSync(0):undefined,encoding:'utf8'});
 process.stdout.write(r.stdout);process.stderr.write(r.stderr);process.exit(r.status)
}
throw Error('unexpected call');
`

test('native volume identityをVM内pathのHost存在で否定せず、RW/alias/欠測は拒否する', async t => {
  const root = await mkdtemp(join(tmpdir(),'native-volume-writer-'))
  t.after(()=>rm(root,{recursive:true,force:true}))
  await mkdir(root+'/runtime');await mkdir(root+'/runtime/data');await mkdir(root+'/runtime/home')
  await writeFile(root+'/docker','#!'+process.execPath+'\n'+fakeDocker);await chmod(root+'/docker',0o700)
  const mounts=[{type:'bind',source:root+'/runtime/data',target:'/srv/bellteam'},
    {type:'bind',source:root+'/runtime/home',target:'/home/bell'},
    {type:'volume',source:'cursor-cli',target:'/home/bell/.local'},
    ...['state','rooms','owner','logs','shared/tools/bellteam-settings','shared/tools/apns'].map(n=>({type:'volume',source:'server-state',target:'/srv/bellteam/'+n,volume:{nocopy:true,subpath:n.split('/').at(-1)}})),
    {type:'volume',source:'server-state',target:'/run/bellteam-maintenance',read_only:true,volume:{nocopy:true}}]
  const config={services:{bellteam:{volumes:mounts}},volumes:{'cursor-cli':{name:'cursor'},'server-state':{name:'native-state',external:true}}}
  const info=name=>({name,driver:'local',mountpoint:'/vm-only-bellteam-test/'+name+'/_data',optionCount:0,type:null,device:null,options:null})
  const state=info('native-state'),other=info('unrelated')
  await assert.rejects(stat(state.mountpoint),{code:'ENOENT'})
  const container=(Name,RW=true,extra={})=>({id:'c'.repeat(64),running:true,restarting:false,restartPolicy:'no',mounts:[{Type:'volume',Name,Source:info(Name).mountpoint+'/state',RW}],...extra})
  const source=new URL('../src/server-state-writers.mjs',import.meta.url).pathname
  const run=(containers,volumes=[state])=>exec('sh',[new URL('../scripts/assert-state-writers-stopped.sh',import.meta.url).pathname],{env:{...process.env,
    PATH:root+':'+process.env.PATH,TEST_ROOT:root,TEST_SOURCE:source,TEST_CONFIG:JSON.stringify(config),TEST_CONTAINERS:JSON.stringify(containers),TEST_VOLUMES:JSON.stringify(volumes)}})
  assert.match((await run([])).stdout,/"writers":0/)
  assert.match((await run([container('unrelated')],[state,other])).stdout,/"writers":0/)
  assert.match((await run([container('native-state',false)])).stdout,/"writers":0/)
  await assert.rejects(run([container('native-state')]),e=>e.code===1&&/WRITERS_RUNNING/.test(e.stderr))
  await assert.rejects(run([container('native-state',true,{running:false,restartPolicy:'always'})]),e=>e.code===1&&/WRITERS_RUNNING/.test(e.stderr))
  await assert.rejects(run([],[]),{code:43})
  await assert.rejects(run([],[{...state,driver:'unknown'}]),e=>e.code===1&&/WRITER_METADATA_INVALID/.test(e.stderr))
  const bound={...other,optionCount:3,type:'none',device:root+'/runtime/data',options:'bind'}
  await assert.rejects(run([container('unrelated')],[state,bound]),e=>e.code===1&&/WRITERS_RUNNING/.test(e.stderr))
  await assert.rejects(run([],[{...state,optionCount:3,type:'none',device:root+'/foreign',options:'bind'}]),e=>e.code===1&&/WRITER_METADATA_INVALID/.test(e.stderr))
})
