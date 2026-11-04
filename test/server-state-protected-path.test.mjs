import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtemp, mkdir, writeFile, chmod, rm, symlink, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { canonicalStateWriterSources } from '../src/server-state-writers.mjs'

const exec = promisify(execFile)
const docker = String.raw`
const fs=require('node:fs'),cp=require('node:child_process'),a=process.argv.slice(2),e=process.env;
const out=v=>console.log(typeof v==='string'?v:JSON.stringify(v));
if(a[0]==='compose'){out(a.includes('--images')?'fixture':JSON.parse(e.TEST_CONFIG));process.exit(0)}
if(a[0]==='image'){out('sha256:'+'a'.repeat(64));process.exit(0)}
if(a[0]==='ps'){out('c'.repeat(64));process.exit(0)}
if(a[0]==='inspect'){out(JSON.parse(e.TEST_CONTAINER));process.exit(0)}
if(a[0]==='run'){
 const mode=a.at(-1),i=a.indexOf('--mount'),mount=i<0?'':a[i+1];
 let file=e.TEST_SOURCE,dir;
 if(i>=0){dir=mount.match(/^type=bind,source=(.+),target=\/check,readonly$/)?.[1];if(!dir)throw Error('evidence mount');
 file=e.TEST_ROOT+'/reader.mjs';fs.writeFileSync(file,fs.readFileSync(e.TEST_SOURCE,'utf8').replaceAll('/check/',dir+'/'));}
 if(mode==='canonical'){
  for(const v of ['--read-only','--network','none','--cap-drop','ALL','--cap-add','DAC_READ_SEARCH','no-new-privileges','type=bind,source=/,target=/host,readonly'])if(!a.includes(v))throw Error('reader contract '+v);
  import(require('node:url').pathToFileURL(e.TEST_SOURCE)).then(async m=>{process.stdout.write(await m.canonicalStateWriterSources(fs.readFileSync(dir+'/sources.txt','utf8'),e.TEST_DAEMON_ROOT));}).catch(()=>{console.error('SERVER_STATE_WRITER_METADATA_INVALID');process.exitCode=1});
 }else{const r=cp.spawnSync(process.execPath,[file,mode],{input:a.includes('-i')?fs.readFileSync(0):undefined,encoding:'utf8'});process.stdout.write(r.stdout);process.stderr.write(r.stderr);process.exit(r.status)}
}else throw Error('unexpected call');
`

test('不可視bindは固定RO読取へ渡し、別保存先を許可・絶対symlink alias writerを拒否する', async t => {
  const root = await mkdtemp(join(tmpdir(), 'protected-writer-'))
  t.after(() => rm(root, { recursive:true, force:true }))
  const daemon = root+'/daemon', source = '/bellteam-unsearchable-'+process.pid+'/home', selected='/bellteam-new-'+process.pid
  await mkdir(daemon+source,{recursive:true,mode:0o700})
  await mkdir(daemon+selected+'/home',{recursive:true});await mkdir(daemon+selected+'/data')
  await assert.rejects(stat(source),{code:'ENOENT'}) // Host view cannot observe the daemon path.
  await writeFile(root+'/docker','#!'+process.execPath+'\n'+docker);await chmod(root+'/docker',0o700)
  const config={services:{bellteam:{volumes:[{type:'bind',source:selected+'/data',target:'/srv/bellteam'},
    {type:'bind',source:selected+'/home',target:'/home/bell'},{type:'volume',source:'cursor',target:'/home/bell/.local'}]}},volumes:{cursor:{name:'fixture_cursor'}}}
  const container={id:'c'.repeat(64),running:true,restarting:false,restartPolicy:'unless-stopped',mounts:[{Type:'bind',Source:source,RW:true}]}
  const env={...process.env,PATH:root+':'+process.env.PATH,TEST_ROOT:root,TEST_DAEMON_ROOT:daemon,
    TEST_SOURCE:new URL('../src/server-state-writers.mjs',import.meta.url).pathname,TEST_CONFIG:JSON.stringify(config),TEST_CONTAINER:JSON.stringify(container)}
  const run=()=>exec('sh',[new URL('../scripts/assert-state-writers-stopped.sh',import.meta.url).pathname],{env})
  assert.match((await run()).stdout,/"writers":0/)
  await rm(daemon+source,{recursive:true});await symlink(selected+'/home',daemon+source)
  await assert.rejects(run(),e=>e.code===1&&/SERVER_STATE_WRITERS_RUNNING/.test(e.stderr))
  await rm(daemon+source);await symlink('/missing-target',daemon+source)
  await assert.rejects(run(),e=>e.code===1&&/SERVER_STATE_WRITER_METADATA_INVALID/.test(e.stderr))
  assert.equal(await canonicalStateWriterSources('planned\n'+selected+'/future/child\nvolume\n/vm/volume\n',daemon),
    selected+'/future/child\n'+selected+'/future/child\n/vm/volume\n/vm/volume\n')
})
