import assert from 'node:assert/strict'
import test from 'node:test'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { mkdtemp, mkdir, writeFile, readFile, chmod, rm, readdir, stat, copyFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
const exec = promisify(execFile), repo = fileURLToPath(new URL('../', import.meta.url))
const currentImage='sha256:'+'a'.repeat(64),oldImage='sha256:'+'b'.repeat(64),cid='c'.repeat(64)
const fakeDocker=String.raw`#!/usr/bin/env node
import fs from 'node:fs';import path from 'node:path';import {spawnSync} from 'node:child_process';
const a=process.argv.slice(2), e=process.env, root=e.TEST_ROOT,repo=e.TEST_REPO;
fs.appendFileSync(root+'/calls',JSON.stringify({args:a,compose:e.COMPOSE_FILE??null,project:e.COMPOSE_PROJECT_NAME??null,image:e.BELLTEAM_SERVER_IMAGE??null})+'\n');
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
 const image=a.at(-1);let resolved=image.startsWith('sha256:')?image:'sha256:'+'a'.repeat(64);
 if(e.TEST_TAG_MOVES&&image==='fixture:new'){
  if(fs.existsSync(root+'/tag-resolved'))resolved='sha256:'+'e'.repeat(64);
  fs.writeFileSync(root+'/tag-resolved','');
 }
 emit(a.includes('--format')?resolved:[{Id:image}]);
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
 if(e.TEST_STOP_FAIL)process.exit(59);
 const s=state();s.State.Running=!!e.TEST_STILL_RUNNING;s.State.Restarting=!!e.TEST_STILL_RESTARTING;fs.writeFileSync(root+'/runtime.json',JSON.stringify(s));emit(s.Id);
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
  if(e.TEST_EXTRACT_FAIL===name)process.exit(54);
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
  if(e.TEST_CONFIG_FAIL&&!e.COMPOSE_FILE&&!a.includes('-f'))process.exit(53);
  if(a.includes('--images'))emit(model.services.bellteam.image);
  else if(a.includes('--hash'))emit('bellteam '+(e.TEST_HASH_MISMATCH?'wrong':'old-hash'));
  else if(a[a.indexOf('--format')+1]==='yaml')emit('name: selected-project\nvolumes:\n  cursor-cli:\n    name: fixture_cursor');
  else {
   emit(model);
   if(e.TEST_CHANGE_INPUT&&!e.COMPOSE_FILE?.endsWith('.json')&&!a.includes('-f')){
    model.name='changed-after-render';model.services.bellteam.environment.SECRET='changed-after-render';
    fs.writeFileSync(root+'/normal.json',JSON.stringify(model));
   }
  }
 }else if(a.includes('port'))emit(e.TEST_ENDPOINT??'127.0.0.1:18891');
 else if(a.includes('ps')){if(state())emit(state().Id);}
 else if(a.includes('run')){
  if(a.includes('state-maintenance')){
   const bind=select().services['state-maintenance'].volumes.find(v=>v.target==='/srv/bellteam-runtime');
   try{if(!fs.statSync(bind.source).isDirectory())process.exit(77);}catch{process.exit(77);}
  }
  const phase=a.at(-1);if(phase===e.TEST_FAIL_PHASE)process.exit(55);
 }else if(a.includes('up')){
  if(e.TEST_UP_FAIL)process.exit(58);
  const model=select(),previous=state(),counter=fs.existsSync(root+'/starts')?Number(fs.readFileSync(root+'/starts'))+1:1;
  fs.writeFileSync(root+'/starts',String(counter));
  // Compose restarts an unchanged container and retains its immutable labels.
  const s=e.TEST_REUSE_CID&&previous?.Image===model.services.bellteam.image?previous:
   {Id:'d'.repeat(64),Image:model.services.bellteam.image,Config:{Image:model.services.bellteam.image,Labels:{'com.docker.compose.project':model.name,'com.docker.compose.service':'bellteam','com.docker.compose.project.config_files':e.COMPOSE_FILE,'com.docker.compose.project.working_dir':a[a.indexOf('--project-directory')+1],'com.docker.compose.config-hash':'old-hash'}},Mounts:[]};
  s.State={Running:true,Restarting:false,StartedAt:'after-'+counter};fs.writeFileSync(root+'/runtime.json',JSON.stringify(s));
 }else if(!a.includes('pull')&&!a.includes('build'))process.exit(93);
}else process.exit(92);
function pathToFileURL(p){return new URL('file://'+p);}
`
async function fixture(t,{legacy=false,server=false}={}) {
 const root=await mkdtemp(join(tmpdir(),'unified-installer-'));t.after(()=>rm(root,{recursive:true,force:true}))
 const install=join(root,'install'),bin=join(root,'bin');await mkdir(install);await mkdir(bin)
 const base=[{type:'bind',source:join(install,'runtime/home'),target:'/home/bell'},
 {type:'bind',source:join(install,'runtime/data'),target:'/srv/bellteam'},
 {type:'volume',source:'cursor-cli',target:'/home/bell/.local'}]
 const normal={name:'selected-project',services:{bellteam:{image:'fixture:new',environment:{SECRET:'private-value',VALUE:'literal $$KEEP'},labels:{'fixture.$$key':'literal $$KEEP'},volumes:[...base,
 ...['state','rooms','owner','logs','shared/tools/bellteam-settings','shared/tools/apns'].map(n=>({type:'bind',source:join(install,'runtime/server-only/state-data',n.split('/').at(-1)),target:'/srv/bellteam/'+n,bind:{create_host_path:false}})),
 {type:'bind',source:join(install,'runtime/server-only/state-data'),target:'/run/bellteam-maintenance',read_only:true,bind:{create_host_path:false}}]}},volumes:{'cursor-cli':{name:'fixture_cursor'}}}
 const old=structuredClone(normal);old.services.bellteam.image='fixture:old';old.services.bellteam.environment.SECRET='old-private';
 if(!server)old.services.bellteam.volumes=base;
 await writeFile(root+'/normal.json',JSON.stringify(normal));await writeFile(root+'/old.json',JSON.stringify(old))
 await writeFile(bin+'/docker',fakeDocker);await chmod(bin+'/docker',0o700)
 if(legacy||server)await writeFile(root+'/runtime.json',JSON.stringify({Id:cid,Image:oldImage,State:{Running:true,Restarting:false,StartedAt:'before'},Config:{Image:'fixture:old',Labels:{'com.docker.compose.project':'selected-project','com.docker.compose.service':'bellteam','com.docker.compose.project.config_files':install+'/compose.yaml','com.docker.compose.project.working_dir':install,'com.docker.compose.config-hash':'old-hash'}},Mounts:[]}))
 const env={...process.env,PATH:bin+':'+process.env.PATH,BELLTEAM_INSTALL_DIR:install,TEST_ROOT:root,TEST_REPO:repo}
 delete env.COMPOSE_FILE;delete env.COMPOSE_PROJECT_NAME
 return {root,install,normal,writeModel:()=>writeFile(root+'/normal.json',JSON.stringify(normal)),run:(args=[],extra={})=>exec('sh',[...(extra.TEST_TRACE?['-x']:[]),repo+'/distribution/server/install.sh',...args],{env:{...env,...extra}}),
 calls:async()=> (await readFile(root+'/calls','utf8')).trim().split('\n').map(JSON.parse),
 saved:async()=>join(install,(await readdir(install)).find(n=>n.startsWith('.bellteam-compose.')&&n!=='.bellteam-compose.existing'))}
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
 assert.equal(calls.some(c=>c.args[0]==='stop'),false)
 const maintenanceRuns=calls.filter(c=>c.args.includes('state-maintenance'));
 assert.equal(maintenanceRuns.length,2);assert.ok(maintenanceRuns.every(c=>c.args.includes('--no-deps')&&c.args.includes('-T')))
 assert.equal(calls.some(c=>c.args[0]==='compose'&&c.args[1]==='run'),false)
 assert.deepEqual(calls.find(c=>c.args.includes('up')).args.slice(0,3),['compose','--project-directory',f.install])
 assert.doesNotMatch(stdout,/private-value/)
})

test('公開2fileのみの初回はruntime bind元を作ってからprepare→to-server→upへ進む',async t=>{
 const f=await fixture(t);
 for(const name of ['install.sh','compose.yaml'])await copyFile(repo+'/distribution/server/'+name,f.install+'/'+name)
 assert.deepEqual((await readdir(f.install)).sort(),['compose.yaml','install.sh'])
 await assert.rejects(stat(f.install+'/runtime'),{code:'ENOENT'})
 await f.run();assert.ok((await stat(f.install+'/runtime')).isDirectory())
 const calls=await f.calls(),prepare=calls.findIndex(c=>c.args.at(-1)==='prepare'),transfer=calls.findIndex(c=>c.args.at(-1)==='to-server'),up=calls.findIndex(c=>c.args.includes('up'));
 assert.ok(prepare>=0&&transfer>prepare&&up>transfer)
 assert.equal(calls.some(c=>c.args[0]==='stop'),false)
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
 assert.deepEqual(up.args.slice(0,3),['compose','--project-directory',f.install])
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
  for(const name of ['normal.json','compose.state-maintenance.json'])assert.ok(await readFile((await f.saved())+'/'+name))
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

test('最初のimage解決後はmutable tagが移っても全consumerへ同じraw IDを渡す',async t=>{
 const f=await fixture(t);await f.run([],{TEST_TAG_MOVES:'1'});const calls=await f.calls();
 assert.equal(calls.filter(c=>c.args[0]==='image'&&c.args.includes('--format')&&c.args.at(-1)==='fixture:new').length,1)
 const extracts=calls.filter(c=>c.args.includes('/bin/cat'));
 assert.equal(extracts.length,4);assert.ok(extracts.every(c=>c.args.includes(currentImage)))
 const readers=calls.filter(c=>c.args.includes('/app/src/server-state-writers.mjs'));
 assert.ok(readers.length>0&&readers.every(c=>c.args.includes(currentImage)))
 for(const phase of ['prepare','to-server','cursor-update']){
  const call=calls.find(c=>c.args.at(-1)===phase);assert.ok(call);assert.equal(call.image,currentImage)
 }
 const saved=await f.saved();
 for(const [name,service] of [['normal.json','bellteam'],['compose.state-maintenance.json','state-maintenance']])
  assert.equal(JSON.parse(await readFile(saved+'/'+name)).services[service].image,currentImage)
 assert.equal(calls.find(c=>c.args.includes('up')).image,currentImage)
 assert.ok(!JSON.stringify(calls).includes('sha256:'+'e'.repeat(64)))
})

test('解決済みnormalは元入力の変更後もproject・secret・dollarを保持し、他世代を変更しない',async t=>{
 const f=await fixture(t),previous=f.install+'/.bellteam-compose.existing';
 await mkdir(previous,{mode:0o700});await writeFile(previous+'/sentinel','keep');
 await f.run([],{TEST_CHANGE_INPUT:'1',COMPOSE_FILE:'selected-base.yaml;selected-overlay.yaml',COMPOSE_PATH_SEPARATOR:';'})
 const saved=await f.saved(),model=JSON.parse(await readFile(saved+'/normal.json'));
 assert.equal(JSON.parse(await readFile(f.root+'/normal.json')).name,'changed-after-render')
 assert.equal(model.name,'selected-project');assert.equal(model.services.bellteam.environment.SECRET,'private-value')
 assert.equal(model.services.bellteam.environment.VALUE,'literal $$KEEP');
 assert.equal(model.services.bellteam.labels['fixture.$key'],'literal $$KEEP')
 assert.equal((await stat(saved)).mode&0o777,0o700)
 for(const name of ['normal.json','compose.state-maintenance.json'])assert.equal((await stat(saved+'/'+name)).mode&0o777,0o600)
 assert.equal(await readFile(previous+'/sentinel','utf8'),'keep')
 const maintenance=JSON.parse(await readFile(saved+'/compose.state-maintenance.json'));
 assert.doesNotMatch(JSON.stringify(maintenance),/SECRET|private-value/)
 const calls=await f.calls(),up=calls.find(c=>c.args.includes('up'));
 assert.equal(calls[0].compose,'selected-base.yaml;selected-overlay.yaml')
 assert.equal(up.compose,saved+'/normal.json');assert.equal(up.project,'selected-project')
})

test('immutable配布refだけをraw imageと併記し、mutable tagやraw IDをrefへ補完しない',async t=>{
 for(const selected of ['fixture:new',currentImage,'ghcr.io/fixture/server@sha256:'+'f'.repeat(64)]){
  const f=await fixture(t);f.normal.services.bellteam.image=selected;await f.writeModel();await f.run();
  const model=JSON.parse(await readFile((await f.saved())+'/normal.json'));
  assert.equal(model.services.bellteam.image,currentImage)
  assert.equal(model['x-bellteam-image-ref'],selected.includes('@sha256:')?selected:undefined)
 }
})

test('初期config・image解決・image file抽出失敗は旧本体stop前に終了する',async t=>{
 for(const extra of [{TEST_CONFIG_FAIL:'1'},{TEST_INSPECT_FAIL:'1'},
  ...['compose.cursor-update.yaml','compose.state-maintenance.json','scripts/update-cursor.sh','scripts/assert-state-writers-stopped.sh'].map(name=>({TEST_EXTRACT_FAIL:name}))]){
  const f=await fixture(t,{legacy:true});await assert.rejects(f.run([],extra));
  const calls=await f.calls();
  assert.equal(calls.some(c=>c.args[0]==='stop'||c.args.includes('up')||c.args.includes('state-maintenance')||c.args.at(-1)==='cursor-update'),false)
  assert.equal(JSON.parse(await readFile(f.root+'/runtime.json')).State.Running,true)
  assert.deepEqual((await readdir(f.install)).filter(n=>n.startsWith('.bellteam-compose.')),[])
 }
})

test('共通親・project・6対応・control RO・世代のbind露出が不正ならstop前に拒否する',async t=>{
 const changes=[
  f=>delete f.normal.name,
  f=>f.normal.services.bellteam.volumes.find(v=>v.target==='/home/bell').source=f.install+'/different/home',
  f=>f.normal.services.bellteam.volumes.splice(f.normal.services.bellteam.volumes.findIndex(v=>v.target==='/srv/bellteam/owner'),1),
  f=>f.normal.services.bellteam.volumes.find(v=>v.target==='/srv/bellteam/state').source=f.install+'/different/state',
  f=>f.normal.services.bellteam.volumes.find(v=>v.target==='/run/bellteam-maintenance').read_only=false,
  f=>f.normal.services.bellteam.volumes.push({type:'bind',source:f.install,target:'/exposed'}),
 ];
 for(const change of changes){
  const f=await fixture(t,{legacy:true});change(f);await f.writeModel();
  await assert.rejects(f.run(),e=>e.code===1&&e.stderr.includes('SERVER_STATE_CONFIG_UNAVAILABLE'))
  assert.equal((await f.calls()).some(c=>c.args[0]==='stop'),false)
  assert.deepEqual((await readdir(f.install)).filter(n=>n.startsWith('.bellteam-compose.')),[])
 }
})

test('model保存の失敗は未公開世代だけを除去し、旧本体と既存世代を保持する',async t=>{
 for(const command of ['sed','cp']){
  const f=await fixture(t,{legacy:true}),previous=f.install+'/.bellteam-compose.existing';
  await mkdir(previous,{mode:0o700});await writeFile(previous+'/sentinel','keep')
  await writeFile(f.root+'/bin/'+command,'#!/bin/sh\nexit 71\n');await chmod(f.root+'/bin/'+command,0o700)
  await assert.rejects(f.run(),{code:71})
  assert.equal((await f.calls()).some(c=>c.args[0]==='stop'||c.args.includes('up')),false)
  assert.deepEqual((await readdir(f.install)).filter(n=>n.startsWith('.bellteam-compose.')),['.bellteam-compose.existing'])
  assert.equal(await readFile(previous+'/sentinel','utf8'),'keep')
  assert.equal(JSON.parse(await readFile(f.root+'/runtime.json')).State.Running,true)
 }
})

test('exact CIDのstop失敗とRunning/Restarting欠測は保守より前に拒否する',async t=>{
 for(const extra of [{TEST_STOP_FAIL:'1'},{TEST_STILL_RUNNING:'1'},{TEST_STILL_RESTARTING:'1'}]){
  const f=await fixture(t,{legacy:true});
  await assert.rejects(f.run([],extra),e=>extra.TEST_STOP_FAIL?e.code===59:e.code===1&&e.stderr.includes('SERVER_STATE_STOP_UNCONFIRMED'))
  const calls=await f.calls();assert.deepEqual(calls.filter(c=>c.args[0]==='stop').map(c=>c.args),[['stop',cid]])
  assert.equal(calls.some(c=>c.args.includes('state-maintenance')||c.args.at(-1)==='cursor-update'||c.args.includes('up')),false)
  assert.equal(JSON.parse(await readFile((await f.saved())+'/previous-runtime.json'))[0].Id,cid)
 }
})

test('Cursorと通常upの失敗はそのterminalを一度返し、現在と旧設定をprivate世代へ保持する',async t=>{
 for(const extra of [{TEST_FAIL_PHASE:'cursor-update'},{TEST_UP_FAIL:'1'}]){
  const f=await fixture(t,{legacy:true});
  await assert.rejects(f.run([],extra),e=>e.code===(extra.TEST_UP_FAIL?58:55))
  const saved=await f.saved(),calls=await f.calls();
  assert.equal(calls.filter(c=>c.args.at(-1)==='cursor-update').length,1)
  assert.equal(calls.filter(c=>c.args.includes('up')).length,extra.TEST_UP_FAIL?1:0)
  assert.equal((await stat(saved)).mode&0o777,0o700)
  for(const name of ['normal.json','compose.state-maintenance.json','previous-normal.json','previous-runtime.json'])
   assert.equal((await stat(saved+'/'+name)).mode&0o777,0o600)
  assert.equal(JSON.parse(await readFile(saved+'/normal.json')).services.bellteam.image,currentImage)
  assert.equal(JSON.parse(await readFile(saved+'/previous-normal.json')).services.bellteam.image,oldImage)
 }
})

test('server layoutの旧世代へ復旧するときも同じ保守入口を通り、逆移行やCID削除を行わない',async t=>{
 const f=await fixture(t,{server:true});await f.run();const saved=await f.saved(),before=(await f.calls()).length;
 await f.run(['--recover',saved]);const calls=(await f.calls()).slice(before);
 assert.equal(calls.filter(c=>c.args.at(-1)==='to-server').length,1)
 assert.equal(calls.some(c=>c.args.at(-1)==='to-legacy'||c.args[0]==='rm'||c.args.at(-1)==='cursor-update'),false)
 assert.equal(calls.find(c=>c.args.includes('up')).compose,saved+'/previous-normal.json')
 assert.equal(JSON.parse(await readFile(f.root+'/runtime.json')).Image,oldImage)
})

test('旧公開保存世代のworking_dirからno-op更新してもraw image・設定のexact原本を保存する',async t=>{
 for(const name of ['normal.json','previous-normal.json']){
  const f=await fixture(t,{server:true}),previous=f.install+'/.bellteam-compose.existing';await mkdir(previous,{mode:0o700})
  const model=structuredClone(f.normal);model.services.bellteam.image=currentImage;
  await writeFile(previous+'/'+name,JSON.stringify(model),{mode:0o600})
  const current=JSON.parse(await readFile(f.root+'/runtime.json'));
  current.Image=currentImage;current.Config.Image=currentImage;
  current.Config.Labels['com.docker.compose.project.config_files']=previous+'/'+name;
  current.Config.Labels['com.docker.compose.project.working_dir']=previous;
  await writeFile(f.root+'/runtime.json',JSON.stringify(current))
  const result=await f.run(),saved=await f.saved();assert.doesNotMatch(result.stderr,/旧設定を証明できません/)
  const original=JSON.parse(await readFile(saved+'/previous-normal.json'));
  assert.equal(original.services.bellteam.image,currentImage)
  assert.equal(original.services.bellteam.environment.SECRET,'private-value')
  assert.equal(original.services.bellteam.environment.VALUE,'literal $$KEEP')
  assert.deepEqual(original.services.bellteam.volumes,model.services.bellteam.volumes)
  assert.deepEqual(JSON.parse(await readFile(saved+'/previous-runtime.json')),[current])
  assert.deepEqual(JSON.parse(await readFile(previous+'/'+name)),model)
  const calls=await f.calls(),render=calls.find(c=>c.args.includes('--env-file')&&c.args.includes(previous+'/'+name));
  assert.ok(render);assert.equal(render.args[render.args.indexOf('--project-directory')+1],previous)
  assert.deepEqual(calls.find(c=>c.args.includes('up')).args.slice(0,3),['compose','--project-directory',f.install])
 }
})

test('Composeが同一CIDと旧config_filesを保持して再起動した後もserver世代へ復旧できる',async t=>{
 const f=await fixture(t),extra={TEST_REUSE_CID:'1'};
 await f.run([],extra);const first=JSON.parse(await readFile(f.root+'/runtime.json'));
 const updated=await f.run([],extra),saved=updated.stdout.match(/^saved-compose=(.*)$/m)[1];
 const second=JSON.parse(await readFile(f.root+'/runtime.json'));
 assert.equal(second.Id,first.Id);assert.equal(second.Image,first.Image)
 assert.deepEqual(second.Config,first.Config);assert.notEqual(second.State.StartedAt,first.State.StartedAt)
 assert.notEqual(second.Config.Labels['com.docker.compose.project.config_files'],saved+'/normal.json')
 const original=JSON.parse(await readFile(saved+'/previous-runtime.json'));
 assert.deepEqual(original,[first]);const before=(await f.calls()).length;
 await f.run(['--recover',saved],extra);const restored=JSON.parse(await readFile(f.root+'/runtime.json'));
 assert.equal(restored.Id,first.Id);assert.equal(restored.Image,first.Image);assert.deepEqual(restored.Config,first.Config)
 assert.notEqual(restored.State.StartedAt,second.State.StartedAt)
 assert.deepEqual(JSON.parse(await readFile(saved+'/previous-runtime.json')),original)
 const calls=(await f.calls()).slice(before);
 assert.equal(calls.filter(c=>c.args.at(-1)==='to-server').length,1)
 assert.equal(calls.some(c=>c.args.at(-1)==='to-legacy'||c.args[0]==='rm'||c.args.at(-1)==='cursor-update'),false)
 assert.equal(calls.find(c=>c.args.includes('up')).compose,saved+'/previous-normal.json')
})

test('内部handoff後にcurrent CIDが変わった場合は、元raw原本を保持してstop前に拒否する',async t=>{
 const f=await fixture(t,{legacy:true}),handoff=f.root+'/handoff';await mkdir(handoff,{mode:0o700})
 const original=await readFile(f.root+'/runtime.json','utf8'),old=JSON.parse(await readFile(f.root+'/old.json'));
 old.services.bellteam.image=oldImage;
 await writeFile(handoff+'/previous-normal.json',JSON.stringify(old),{mode:0o600})
 await writeFile(handoff+'/previous-runtime.json',original,{mode:0o600})
 const current=JSON.parse(original);current.Id='f'.repeat(64);await writeFile(f.root+'/runtime.json',JSON.stringify(current))
 await assert.rejects(f.run([],{BELLTEAM_PREVIOUS_COMPOSE:handoff+'/previous-normal.json'}),e=>e.code===1&&e.stderr.includes('SERVER_STATE_GENERATION_CHANGED'))
 const calls=await f.calls();assert.equal(calls.some(c=>c.args[0]==='stop'||c.args.includes('state-maintenance')||c.args.at(-1)==='cursor-update'||c.args.includes('up')),false)
 assert.equal(await readFile(handoff+'/previous-runtime.json','utf8'),original)
 assert.equal(JSON.parse(await readFile(f.root+'/runtime.json')).Id,current.Id)
})

test('接続案内は公開bindとLAN endpointを区別し、認証案内に秘密を含めない',async t=>{
 for(const [endpoint,url] of [['0.0.0.0:18891','http://localhost:18891'],['[::]:18891','http://localhost:18891'],['192.168.1.25:18891','http://192.168.1.25:18891']]){
  const f=await fixture(t),result=await f.run([],{TEST_ENDPOINT:endpoint});
  assert.ok(result.stdout.includes(url));assert.match(result.stdout,/公式サイトで認証/);assert.doesNotMatch(result.stdout,/private-value/)
 }
})
