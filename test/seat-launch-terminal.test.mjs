import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import test from 'node:test'

// The launcher under the fixed seat identity, with Aiterm replaced by a fixture that reports what it was given.
function launch(request) {
  const bootstrap = String.raw`
import { registerHooks } from 'node:module';
Object.assign(process,{getuid:()=>1000,geteuid:()=>1000,getgid:()=>1000,cwd:()=>'/srv/member'});
registerHooks({
 resolve(specifier,context,next){return specifier==='./aiterm-client.mjs'?{url:'fixture:aiterm-client',shortCircuit:true}:next(specifier,context)},
 load(url,context,next){return url==='fixture:aiterm-client'?{format:'module',shortCircuit:true,source:
  "export const runtimeLaunchEnv=()=>({}); export const accountLoginEnvironment=async()=>({CLAUDE_CODE_OAUTH_TOKEN:'login-value'});"+
  "export class AitermClient { async call(name,args){return {content:[{type:'text',text:JSON.stringify({cwd:args.cwd,terminal:args.terminal,env_vars:args.env_vars,set:args.env_vars.map(k=>process.env[k]?'set':'missing')})}]}} async close(){} }"}:next(url,context)}
});
await import(new URL('./src/run-seat-aiterm-launch.mjs', 'file://' + process.env.ROOT + '/').href);
`
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', bootstrap], {
    input: JSON.stringify({ command: 'fixture-only', args: [], ...request }), encoding: 'utf8',
    env: { PATH: process.env.PATH, HOME: '/home/server', ROOT: new URL('..', import.meta.url).pathname.replace(/\/$/, '') },
  })
  return result.status === 0 ? JSON.parse(JSON.parse(result.stdout).result.content[0].text) : { failed: result.stderr.trim() }
}

const terminal = { ref: '725ca83c-f52f-4036-9390-8d9e4c482f14', target: { host: '192.168.1.12', user: 'kite', port: 22 }, trustRevision: 'r1', credentialRevision: 'c1' }

test('terminal launch: terminal cwd accepted and only the named private env crosses, value never in output', () => {
  const result = launch({ launch: { cwd: '/Users/kite/work', terminal }, privateEnvNames: ['BELLTEAM_MCP_TOKEN', 'CLAUDE_CODE_OAUTH_TOKEN'],
    privateEnv: { BELLTEAM_MCP_TOKEN: 'seat-token-value' }, claudeLogin: '2nd' })
  assert.deepEqual(result, { cwd: '/Users/kite/work', terminal, env_vars: ['BELLTEAM_MCP_TOKEN', 'CLAUDE_CODE_OAUTH_TOKEN'], set: ['set', 'set'] })
})

test('terminal launch: malformed or missing private env fails before Aiterm; local launch unchanged', () => {
  const base = { launch: { cwd: '/Users/kite/work', terminal }, privateEnvNames: ['BELLTEAM_MCP_TOKEN'], privateEnv: { BELLTEAM_MCP_TOKEN: 'v' } }
  for (const bad of [{ ...base, privateEnvNames: undefined }, { ...base, privateEnvNames: [] }, { ...base, privateEnvNames: ['BAD-NAME'] },
    { ...base, privateEnv: { OTHER: 'v' } }, { ...base, privateEnv: { BELLTEAM_MCP_TOKEN: '' } }, { ...base, privateEnv: {} },
    { ...base, privateEnvNames: ['CLAUDE_CODE_OAUTH_TOKEN'], privateEnv: { CLAUDE_CODE_OAUTH_TOKEN: 'x' } },
    { ...base, launch: { cwd: 'relative', terminal } }, { ...base, launch: { cwd: '/x', terminal, env_vars: [] } },
    { launch: { cwd: '/srv/member' }, privateEnv: { BELLTEAM_MCP_TOKEN: 'v' } }, { launch: { cwd: '/Users/kite/work' } }])
    assert.equal(launch(bad).failed, 'BELLTEAM_SEAT_LAUNCH_FAILED', JSON.stringify(bad))
  const local = launch({ launch: { cwd: '/srv/member' } })
  assert.equal(local.cwd, '/srv/member'); assert.ok(local.env_vars.includes('PATH') && local.env_vars.includes('HOME'))
})
