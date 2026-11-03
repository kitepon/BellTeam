import assert from 'node:assert/strict'
import { spawn, execFile } from 'node:child_process'
import { once } from 'node:events'
import { promisify } from 'node:util'
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
const execute = promisify(execFile)
for (const component of ['usage', 'diagnostics']) test(`${component} fixed C preserves private locks, clears env and releases on OS close`, { timeout: 10000 }, async t => {
  const root=await mkdtemp(join(tmpdir(),'module-c-'))
  t.after(()=>rm(root,{recursive:true,force:true}))
  const privateRoot=join(root,'private'), stateRoot=join(root,'state'), app=join(root,'app')
  await mkdir(privateRoot,{mode:0o750});await mkdir(stateRoot);await mkdir(join(app,'src'),{recursive:true})
  await writeFile(join(app,`src/${component}-entry.mjs`),`
import assert from 'node:assert/strict'
import {fstatSync,readFileSync} from 'node:fs'
assert.ok(fstatSync(4).isDirectory());assert.ok(fstatSync(5).isFile())
assert.match(readFileSync('/proc/self/fdinfo/4','utf8'),/FLOCK.*ADVISORY.*READ/)
assert.match(readFileSync('/proc/self/fdinfo/5','utf8'),/FLOCK.*ADVISORY.*WRITE/)
assert.equal(process.env.LEAK,undefined);assert.equal(process.env.NODE_OPTIONS,undefined)
assert.equal(process.env.BELLTEAM_DIAGNOSTIC_INVESTIGATIONS,${component === 'diagnostics' ? JSON.stringify('/fixture/notes.json') : 'undefined'})
for (const [fd,kind] of [[4,'READ'],[5,'WRITE']]) assert.ok(new RegExp('FLOCK +ADVISORY +'+kind+' +'+process.pid+' ').test(readFileSync('/proc/self/fdinfo/'+fd,'utf8')))
process.send({ready:true,bytes:Buffer.from('advanced')})
process.on('disconnect',()=>{})
process.on('message',()=>process.disconnect())
`)
  const binary=join(root,'entry'),uid=process.getuid()
  await execute('cc',['-O2','-Wall','-Wextra','-Werror',`-DSERVER_UID=${uid}`,`-DROOT_UID=${uid}`,
    `-DPRIVATE_ROOT="${privateRoot}"`,`-DSTATE_ROOT="${stateRoot}"`,`-DBUILTIN_ROOT="${app}"`,
    `-DNODE_BINARY="${process.execPath}"`,new URL(`../scripts/${component}-start.c`,import.meta.url).pathname,'-o',binary])
  const children=[]
  t.after(async()=>{for(const child of children){if(child.exitCode===null&&child.signalCode===null){const done=once(child,'close');child.kill('SIGKILL');await done}}})
  const start=(arg='builtin')=>{const child=spawn(binary,[arg],{env:{LEAK:'do-not-inherit',NODE_OPTIONS:'--no-warnings',BELLTEAM_DIAGNOSTIC_INVESTIGATIONS:'/fixture/notes.json'},serialization:'advanced',stdio:['ignore','ignore','pipe','ipc']});children.push(child);return child}
  const first=start();const firstEnded=once(first,'close')
  assert.deepEqual((await once(first,'message'))[0],{ready:true,bytes:Buffer.from('advanced')})
  const second=start();assert.equal((await once(second,'close'))[0],126)
  const exclusive=await execute('python3',['-c',`import os,fcntl
fd=os.open(${JSON.stringify(privateRoot)},os.O_RDONLY)
try: fcntl.flock(fd,fcntl.LOCK_EX|fcntl.LOCK_NB)
except BlockingIOError: print('blocked')
`])
  assert.equal(exclusive.stdout.trim(),'blocked')
  first.send({close:true});assert.deepEqual(await firstEnded,[0,null])
  const third=start();const thirdEnded=once(third,'close');await once(third,'message');third.send({close:true});assert.deepEqual(await thirdEnded,[0,null])
  const invalid=start('../elsewhere');assert.equal((await once(invalid,'close'))[0],126)
})
