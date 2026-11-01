import assert from 'node:assert/strict'
import test from 'node:test'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { mkdtemp, mkdir, copyFile, writeFile, readFile, chmod, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
const exec=promisify(execFile),image='ghcr.io/fixture/server@sha256:'+'a'.repeat(64)
async function fixture(t){
 const root=await mkdtemp(join(tmpdir(),'internal-installer-'));t.after(()=>rm(root,{recursive:true,force:true}))
 for(const dir of ['scripts','bin','distribution/server'])await mkdir(join(root,dir),{recursive:true})
 await copyFile(new URL('../scripts/deploy-image.sh',import.meta.url),root+'/scripts/deploy-image.sh')
 await writeFile(root+'/distribution/server/install.sh',`#!/bin/sh
node -e 'require("fs").writeFileSync(process.env.TEST_ROOT+"/installer.json",JSON.stringify({args:process.argv.slice(1),cwd:process.cwd(),compose:process.env.COMPOSE_FILE,project:process.env.COMPOSE_PROJECT_NAME,profile:process.env.BELLTEAM_INTERNAL_PROFILE_FILE,root:process.env.BELLTEAM_INSTALL_DIR,image:process.env.BELLTEAM_SERVER_IMAGE}))' -- "$@"
exit "\${TEST_INSTALL_EXIT:-0}"
`)
 await writeFile(root+'/bin/docker',`#!/bin/sh
printf '%s\\n' "$*" >> "$TEST_ROOT/docker-calls"
case "$*" in
 'compose pull bellteam') exit "\${TEST_PULL_EXIT:-0}";;
 'compose config --images') echo fixture:local;;
 'image inspect --format {{.Id}} fixture:local') printf 'sha256:%064d\\n' 0;;
esac
`);await chmod(root+'/bin/docker',0o700)
 return {root,run:(args=[],extra={})=>exec('sh',['scripts/deploy-image.sh',...args],{cwd:root,env:{...process.env,PATH:root+'/bin:'+process.env.PATH,TEST_ROOT:root,BELLTEAM_SERVER_IMAGE:image,...extra}})}
}
for(const mode of ['image','build','recover'])test(`internal ${mode} uses the same public installer with frozen overlay/profile/working root`,async t=>{
 const f=await fixture(t),recover=mode==='recover',args=recover?['--recover',f.root+'/.bellteam-compose.previous']:[]
 const result=await f.run(args,mode==='build'?{BELLTEAM_SERVER_IMAGE:''}:{})
 assert.match(result.stdout,recover?/recovery-exit=0/:/deploy-exit=0/)
 const call=JSON.parse(await readFile(f.root+'/installer.json'))
 assert.deepEqual(call.args,recover?args:['--no-pull'])
 assert.equal(call.root,f.root);assert.equal(call.cwd,f.root);assert.equal(call.project,'bellteam')
 assert.equal(call.compose,f.root+'/distribution/server/compose.yaml:'+f.root+'/distribution/internal/compose.overlay.yaml')
 assert.equal(call.profile,f.root+'/src/distribution-profile.mjs')
 assert.equal(call.image,mode==='build'?'sha256:'+'0'.repeat(64):image)
 if(!recover){const calls=await readFile(f.root+'/docker-calls','utf8');assert.doesNotMatch(calls,/image save|tar|quiet|fixture-backup/)}
})
test('installer failure propagates once; image acquisition failure never invokes installer',async t=>{
 const f=await fixture(t)
 await assert.rejects(f.run([],{TEST_INSTALL_EXIT:'57'}),e=>e.code===57&&e.stdout.includes('deploy-exit=57'))
 const g=await fixture(t)
 await assert.rejects(g.run([],{TEST_PULL_EXIT:'58'}),e=>e.code===58&&e.stdout.includes('deploy-exit=58'))
 await assert.rejects(readFile(g.root+'/installer.json'),{code:'ENOENT'})
})
