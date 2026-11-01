import assert from 'node:assert/strict'
import test from 'node:test'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { mkdtemp, mkdir, writeFile, readFile, chmod, rm, readdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
const exec = promisify(execFile), repo = fileURLToPath(new URL('../', import.meta.url))
const currentImage='sha256:'+'a'.repeat(64),oldImage='sha256:'+'b'.repeat(64),cid='c'.repeat(64)
const fakeDocker=String.raw`#!/usr/bin/env node
import fs from 'node:fs';import path from 'node:path';import {spawnSync} from 'node:child_process';
const a=process.argv.slice(2), e=process.env, root=e.TEST_ROOT,repo=e.TEST_REPO;
fs.appendFileSync(root+'/calls',JSON.stringify({args:a,compose:e.COMPOSE_FILE??null,project:e.COMPOSE_PROJECT_NAME??null})+'\n');
const load=n=>JSON.parse(fs.readFileSync(root+'/'+n,'utf8'));
const state=()=>fs.existsSync(root+'/runtime.json')?load('runtime.json'):null;
const emit=v=>console.log(typeof v==='string'?v:JSON.stringify(v));
const select=()=>{
 const i=a.indexOf('-f'),file=i>=0?a[i+1]:e.COMPOSE_FILE;
 if(file?.endsWith('previous-compose.yaml'))return load('old.json');
 if(file&&fs.existsSync(file)&&file.endsWith('.json'))return JSON.parse(fs.readFileSync(file));
 return load('normal.json');
};
if(a[0]==='image'&&a[1]==='inspect'){
 if(e.TEST_INSPECT_FAIL)process.exit(57);
 const image=a.at(-1);emit(a.includes('--format')?(image.startsWith('sha256:')?image:'sha256:'+'a'.repeat(64)):[{Id:image}]);
}else if(a[0]==='container'&&a[1]==='inspect'){
 const s=state();if(!s)process.exit(1);
 if(!a.includes('--format'))emit([s]);else{
  const f=a[a.indexOf('--format')+1];
  if(f==='{{.Image}}')emit(s.Image);
  else if(f==='{{.Config.Image}}')emit(s.Config.Image);
  else if(f==='{{.State.Running}} {{.State.Restarting}}')emit(s.State.Running+' '+s.State.Restarting);
  else if(f.startsWith('{{index .Config.Labels'))emit(s.Config.Labels[f.match(/"([^"]+)"/)[1]]??'<no value>');
  else if(f.includes('range .Mounts'))emit('');
  else process.exit(97);
 }
}else if(a[0]==='stop'){
 const s=state();s.State.Running=false;fs.writeFileSync(root+'/runtime.json',JSON.stringify(s));emit(s.Id);
}else if(a[0]==='update')emit(a.at(-1));
else if(a[0]==='rm'){fs.rmSync(root+'/runtime.json',{force:true});emit(a.at(-1));}
else if(a[0]==='ps'){if(state())emit(state().Id);}
else if(a[0]==='inspect'){
 const s=state();emit({id:s.Id,running:s.State.Running,restarting:false,restartPolicy:'unless-stopped',mounts:[]});
}else if(a[0]==='volume'&&a[1]==='inspect')emit([]);
else if(a[0]==='run'){
 const entry=a[a.indexOf('--entrypoint')+1];
 if(entry==='/bin/cat'){
  const name=a.at(-1).replace('/app/','');
  process.stdout.write(name==='compose.yaml'?'synthetic old compose\n':fs.readFileSync(path.join(repo,name)));
 }else if(entry==='/usr/local/bin/node'){
  let j=a.indexOf('-e');
  if(j>=0){const r=spawnSync(process.execPath,a.slice(j),{stdio:'inherit'});process.exit(r.status??98);}
  const script=a.find(x=>x==='/app/src/server-state-writers.mjs'),phase=a.at(-1);
  if(script&&phase==='plan'){
   const r=spawnSync(process.execPath,[repo+'/src/server-state-writers.mjs','plan'],{stdio:'inherit'});process.exit(r.status??98);
  }
  const mount=a[a.indexOf('--mount')+1],check=mount?.match(/^type=bind,source=(.*),target=\/check,readonly$/)?.[1];
  if(script&&check){
   const m=await import(pathToFileURL(repo+'/src/server-state-writers.mjs').href);
   const p=JSON.parse(fs.readFileSync(check+'/plan.json'));const stopped=fs.readFileSync(check+'/stopped-container.txt','utf8').trim();if(stopped)p.stoppedContainer=stopped;
   const rows=n=>fs.readFileSync(check+'/'+n,'utf8').split('\n').filter(Boolean).map(x=>JSON.parse(x));
   const c=rows('containers.jsonl'),v=phase==='volumes'?[]:rows('volumes.jsonl');
   if(phase==='volumes')for(const name of m.stateWriterVolumes(p,c))emit(name);
   else if(phase==='sources')for(const source of m.stateWriterSources(p,c,v)){emit(p.roots.includes(source)?'planned':'observed');emit(source);}
   else if(phase==='verify'){
    if(e.TEST_WRITER_FAIL)process.exit(56);
    const lines=fs.readFileSync(check+'/canonical.txt','utf8').trimEnd().split('\n'),canonical=[];
    for(let i=0;i<lines.length;i+=2)canonical.push({source:lines[i],canonical:lines[i+1]});
    emit(m.assertStateWritersStopped(p,c,canonical,v));
   }else process.exit(96);
  }else process.exit(95);
 }else process.exit(94);
}else if(a[0]==='compose'){
 if(a.includes('config')){
  const model=select();
  if(a.includes('--images'))emit(model.services.bellteam.image);
  else if(a.includes('--hash'))emit('bellteam '+(e.TEST_HASH_MISMATCH?'wrong':'old-hash'));
  else if(a[a.indexOf('--format')+1]==='yaml')emit('name: selected-project\nvolumes:\n  cursor-cli:\n    name: fixture_cursor');
  else emit(model);
 }else if(a.includes('port'))emit(e.TEST_ENDPOINT??'127.0.0.1:18891');
 else if(a.includes('ps')){if(state())emit(state().Id);}
 else if(a.includes('run')){
  const phase=a.at(-1);if(phase===e.TEST_FAIL_PHASE)process.exit(55);
 }else if(a.includes('up')){
  const model=select(),s={Id:'d'.repeat(64),Image:model.services.bellteam.image,State:{Running:true,Restarting:false,StartedAt:'after'},Config:{Image:model.services.bellteam.image,Labels:{'com.docker.compose.project':model.name,'com.docker.compose.service':'bellteam','com.docker.compose.project.config_files':e.COMPOSE_FILE}},Mounts:[]};fs.writeFileSync(root+'/runtime.json',JSON.stringify(s));
 }else if(!a.includes('pull')&&!a.includes('build'))process.exit(93);
}else process.exit(92);
function pathToFileURL(p){return new URL('file://'+p);}
`
async function fixture(t,{legacy=false}={}) {
 const root=await mkdtemp(join(tmpdir(),'unified-installer-'));t.after(()=>rm(root,{recursive:true,force:true}))
 const install=join(root,'install'),bin=join(root,'bin');await mkdir(install);await mkdir(bin)
 const base=[{type:'bind',source:join(install,'runtime/home'),target:'/home/bell'},
 {type:'bind',source:join(install,'runtime/data'),target:'/srv/bellteam'},
 {type:'volume',source:'cursor-cli',target:'/home/bell/.local'}]
 const normal={name:'selected-project',services:{bellteam:{image:'fixture:new',environment:{SECRET:'private-value'},volumes:[...base,
 ...['state','rooms','owner','logs','shared/tools/bellteam-settings','shared/tools/apns'].map(n=>({type:'bind',source:join(install,'runtime/server-only/state-data',n.split('/').at(-1)),target:'/srv/bellteam/'+n,bind:{create_host_path:false}})),
 {type:'bind',source:join(install,'runtime/server-only/state-data'),target:'/run/bellteam-maintenance',read_only:true,bind:{create_host_path:false}}]}},volumes:{'cursor-cli':{name:'fixture_cursor'}}}
 const old={...structuredClone(normal),services:{bellteam:{image:'fixture:old',environment:{SECRET:'old-private'},volumes:base}}}
 await writeFile(root+'/normal.json',JSON.stringify(normal));await writeFile(root+'/old.json',JSON.stringify(old))
 await writeFile(bin+'/docker',fakeDocker);await chmod(bin+'/docker',0o700)
 if(legacy)await writeFile(root+'/runtime.json',JSON.stringify({Id:cid,Image:oldImage,State:{Running:true,Restarting:false,StartedAt:'before'},Config:{Image:'fixture:old',Labels:{'com.docker.compose.project':'selected-project','com.docker.compose.service':'bellteam','com.docker.compose.project.config_files':install+'/compose.yaml','com.docker.compose.project.working_dir':install,'com.docker.compose.config-hash':'old-hash'}},Mounts:[]}))
 const env={...process.env,PATH:bin+':'+process.env.PATH,BELLTEAM_INSTALL_DIR:install,TEST_ROOT:root,TEST_REPO:repo}
 delete env.COMPOSE_FILE;delete env.COMPOSE_PROJECT_NAME
 return {root,install,run:(args=[],extra={})=>exec('sh',[...(extra.TEST_TRACE?['-x']:[]),repo+'/distribution/server/install.sh',...args],{env:{...env,...extra}}),
 calls:async()=> (await readFile(root+'/calls','utf8')).trim().split('\n').map(JSON.parse),
 saved:async()=>join(install,(await readdir(install)).find(n=>n.startsWith('.bellteam-compose.')))}
}

test('公開installerはprivate変数なしで単一runtime serviceを固定しprepare→transfer→Cursor→通常upへ進む',async t=>{
 const f=await fixture(t),{stdout}=await f.run();const calls=await f.calls();
 const saved=await f.saved(),maintenance=JSON.parse(await readFile(saved+'/compose.state-maintenance.json'));
 assert.equal(maintenance.services['state-maintenance'].image,currentImage)
 assert.deepEqual(maintenance.services['state-maintenance'].volumes,[{type:'bind',source:f.install+'/runtime',target:'/srv/bellteam-runtime',bind:{create_host_path:false}}])
 const index=tail=>calls.findIndex(c=>c.args.slice(-tail.length).join('|')===tail.join('|'))
 assert.ok(index(['state-maintenance','prepare'])<index(['state-maintenance','to-server']))
 assert.ok(index(['state-maintenance','to-server'])<index(['--no-deps','cursor-update']))
 assert.ok(index(['--no-deps','cursor-update'])<index(['--pull','never']))
 assert.doesNotMatch(stdout,/private-value/)
})

test('legacy原本をhash確認後raw imageへ固定し、明示復旧は同CID削除→逆移行→旧設定upを行う',async t=>{
 const f=await fixture(t,{legacy:true});await f.run();const saved=await f.saved();
 const original=JSON.parse(await readFile(saved+'/previous-normal.json'))
 assert.equal(original.services.bellteam.image,oldImage)
 assert.equal(original.services.bellteam.environment.SECRET,'old-private')
 await f.run(['--recover',saved]);const calls=await f.calls();
 const rm=calls.findIndex(c=>c.args[0]==='rm'),inverse=calls.findIndex(c=>c.args.at(-1)==='to-legacy')
 assert.ok(rm>0&&inverse>rm)
 const up=calls.findLast(c=>c.args.includes('up'));assert.equal(up.compose,saved+'/previous-normal.json')
 const state=JSON.parse(await readFile(f.root+'/runtime.json'));assert.equal(state.Image,oldImage)
})

test('保守失敗ではCursor/通常upへ進まず、保存世代を保持する',async t=>{
 const f=await fixture(t)
 await assert.rejects(f.run([],{TEST_FAIL_PHASE:'to-server'}),{code:55})
 const calls=await f.calls();assert.equal(calls.filter(c=>c.args.at(-1)==='to-server').length,1)
 assert.equal(calls.some(c=>c.args.includes('up')||c.args.at(-1)==='cursor-update'),false)
 assert.ok(await readFile((await f.saved())+'/normal.json'))
})

test('ローカルimage欠測と未知引数は停止・保守より前に拒否し、通常案内を保つ',async t=>{
 const f=await fixture(t)
 await assert.rejects(f.run(['--unknown']),{code:2})
 await assert.rejects(readFile(f.root+'/calls'),{code:'ENOENT'})
 await assert.rejects(f.run(['--no-pull'],{TEST_INSPECT_FAIL:'1'}),e=>e.code===1&&e.stderr.includes('先にビルド'))
 assert.equal((await f.calls()).some(c=>['stop','up','run'].includes(c.args[0])),false)
 const g=await fixture(t),result=await g.run(['--no-pull'],{TEST_ENDPOINT:'[::]:18891'})
 assert.match(result.stdout,/http:\/\/localhost:18891/);assert.match(result.stdout,/公式サイトで認証/)
 assert.equal((await g.calls()).some(c=>c.args.includes('pull')),false)
})

test('writer拒否とprepare失敗で移行・Cursor・通常upを開始しない',async t=>{
 for(const extra of [{TEST_WRITER_FAIL:'1'},{TEST_FAIL_PHASE:'prepare'}]){
  const f=await fixture(t)
  await assert.rejects(f.run([],extra),{code:extra.TEST_WRITER_FAIL?56:55})
  const calls=await f.calls()
  assert.equal(calls.some(c=>c.args.at(-1)==='to-server'||c.args.at(-1)==='cursor-update'||c.args.includes('up')),false)
 }
})

test('証明できない旧modelは合成せず原本を保持し、その世代のrecoverは拒否する',async t=>{
 const f=await fixture(t,{legacy:true})
 const result=await f.run([],{TEST_HASH_MISMATCH:'1'}),saved=await f.saved()
 assert.match(result.stderr,/旧設定を証明できません/)
 await assert.rejects(readFile(saved+'/previous-normal.json'),{code:'ENOENT'})
 assert.equal(JSON.parse(await readFile(saved+'/previous-runtime.json'))[0].Id,cid)
 const before=(await f.calls()).length
 await assert.rejects(f.run(['--recover',saved]),e=>e.code===1&&e.stderr.includes('PREVIOUS_MODEL_UNVERIFIED'))
 assert.equal((await f.calls()).length,before)
 assert.ok(await readFile(saved+'/normal.json'))
})
