import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
const buffer=Buffer.alloc(1024*1024);
function hash(file) {
  const h=crypto.createHash('sha256'),fd=fs.openSync(file,'r');
  try {for(let n;(n=fs.readSync(fd,buffer,0,buffer.length,null))>0;)h.update(buffer.subarray(0,n));}
  finally {fs.closeSync(fd);} return h.digest('hex');
}
function inventory(root) {
  const rows=[],packages=[];
  function walk(dir) {
    for(const name of fs.readdirSync(dir).sort()) {
      const file=path.join(dir,name),rel=path.relative(root,file),s=fs.lstatSync(file);
      if(s.isDirectory())walk(file);
      else if(s.isSymbolicLink())rows.push([rel,'link',fs.readlinkSync(file)]);
      else if(s.isFile()) {
        rows.push([rel,'file',s.size,hash(file)]);
        if(name==='package.json') {try {const p=JSON.parse(fs.readFileSync(file,'utf8'));if(p.name&&p.version)packages.push({path:rel,name:p.name,version:p.version});}catch{packages.push({path:rel,metadataError:'INVALID_JSON'});}}
      } else throw Error('SPECIAL_RUNTIME_FILE');
    }
  }
  walk(root);return {root,files:rows.length,sha256:crypto.createHash('sha256').update(JSON.stringify(rows)).digest('hex'),rows,packages};
}
const expected=JSON.parse(fs.readFileSync('/app/test/context-files.json','utf8'));
for(const [name,digest] of Object.entries(expected.files))assert.equal(hash('/app/'+name),digest,name);
const sdk=JSON.parse(fs.readFileSync('/app/node_modules/@modelcontextprotocol/sdk/package.json','utf8'));
const jose=JSON.parse(fs.readFileSync('/app/node_modules/jose/package.json','utf8'));
assert.equal(sdk.version,'1.32.2');assert.equal(jose.version,'6.2.13');
const lock=JSON.parse(fs.readFileSync('/app/package-lock.json','utf8')),lockMatched=[],optionalMissing=[];
for(const [name,p] of Object.entries(lock.packages)){if(!name||p.dev)continue;const file='/app/'+name+'/package.json';if(p.optional&&!fs.existsSync(file)){optionalMissing.push(name);continue;}assert.equal(JSON.parse(fs.readFileSync(file,'utf8')).version,p.version,name);lockMatched.push(name);}
assert.equal(JSON.parse(fs.readFileSync('/app/distribution.json','utf8')).profile,'public');
assert.deepEqual(JSON.parse(fs.readFileSync('/app/config/bots.json','utf8')).bots,[]);
for(const name of ['.env','runtime','services/subscriptions/keys','config/models.json'])assert.equal(fs.existsSync('/app/'+name),false,name);
const cgroup=Object.fromEntries(['memory.max','memory.swap.max','cpu.max','pids.max','memory.peak','memory.events'].map(name=>[name,fs.readFileSync('/sys/fs/cgroup/'+name,'utf8').trim()]));
assert.equal(cgroup['memory.max'],'2147483648');assert.equal(cgroup['memory.swap.max'],'0');assert.equal(cgroup['pids.max'],'512');
const [quota,period]=cgroup['cpu.max'].split(/\s+/).map(Number);assert.equal(quota/period,1);
const runtime={};for(const root of ['/app/node_modules','/usr/local/lib/node_modules','/home/bell/.local'])runtime[root]=inventory(root);
const binaries={};for(const file of ['/usr/local/bin/node','/usr/local/bin/grok','/usr/local/bin/rtk','/usr/local/bin/mcp-lazy'])binaries[file]=hash(fs.realpathSync(file));
const osPackages=execFileSync('dpkg-query',['-W','-f=${Package}\t${Version}\n'],{encoding:'utf8',timeout:30000}).trim().split('\n');
const pythonPackages=JSON.parse(execFileSync('python3',['-m','pip','list','--format=json','--disable-pip-version-check'],{encoding:'utf8',timeout:30000}));
console.log(JSON.stringify({stage:'runtime-inventory',node:process.version,source:JSON.parse(fs.readFileSync('/app/distribution.json','utf8')).sourceCommit,contextMatched:Object.keys(expected.files).length,sdk:sdk.version,jose:jose.version,lockMatched,optionalMissing,runtime,binaries,osPackages,pythonPackages,cgroup}));
const child=spawnSync(process.execPath,['--max-old-space-size=256','--test','--test-concurrency=1','--test-reporter=tap','/app/test/seat-mcp-input-limit.test.mjs'],{encoding:'utf8',timeout:30000,env:{PATH:'/usr/local/bin:/usr/bin:/bin',HOME:'/tmp',TMPDIR:'/tmp',NODE_OPTIONS:'--max-old-space-size=256'}});
process.stdout.write(child.stdout??'');process.stderr.write(child.stderr??'');assert.equal(child.status,0);
for(const [key,n] of Object.entries({tests:3,pass:3,fail:0,cancelled:0,skipped:0,todo:0}))assert.match(child.stdout,new RegExp('^# '+key+' '+n+'$','m'));
console.log(JSON.stringify({stage:'guard-complete',pass:3,cgroupFinal:Object.fromEntries(['memory.peak','memory.events'].map(n=>[n,fs.readFileSync('/sys/fs/cgroup/'+n,'utf8').trim()]))}));
