import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { pathToFileURL } from 'node:url'
import test from 'node:test'
import { diagnosticRequestContext } from '../src/diagnostic-request-context.mjs'
import { captureMcpError } from '../src/returned-mcp-error.mjs'

const secret = 'synthetic-private-value'
const launch = { cwd: '/synthetic-seat', prompt: secret }
async function crossBoundary(error) {
  const bootstrap = String.raw`
import { registerHooks } from 'node:module';
Object.assign(process,{getuid:()=>1000,geteuid:()=>1000,getgid:()=>1000,cwd:()=>'/synthetic-seat'});
registerHooks({
 resolve(specifier,context,next){return specifier==='./aiterm-client.mjs'?{url:'fixture:aiterm-client',shortCircuit:true}:next(specifier,context)},
 load(url,context,next){return url==='fixture:aiterm-client'?{format:'module',shortCircuit:true,source:
  "export class AitermClient { async call(){throw Object.assign(new Error('synthetic refusal'),JSON.parse(process.env.FIXTURE_ERROR))} async close(){} }"}:next(url,context)}
});
await import(process.env.TEST_ENTRY);
`
  const entry = process.env.SEAT_LAUNCH_UNDER_TEST ? pathToFileURL(process.env.SEAT_LAUNCH_UNDER_TEST)
    : new URL('../src/run-seat-aiterm-launch.mjs', import.meta.url)
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', bootstrap], {
    input: JSON.stringify({ command: 'fixture-only', args: [], launch }), encoding: 'utf8',
    env: { ...process.env, PRIVATE_VALUE: secret, FIXTURE_ERROR: JSON.stringify(error), TEST_ENTRY: entry.href },
  })
  assert.equal(result.status, 0, result.stderr)
  assert.equal(result.stderr, '')
  assert.ok(!result.stdout.includes(secret))
  return JSON.parse(result.stdout).error
}

const preflight = { schema: 'aiterm.agent-launch-error.v1', harness: 'claude-code',
  code: 'CLAUDE_AUTH_NOT_AUTHENTICATED', phase: 'authentication_preflight', effect: 'not_issued', session_created: false }

test('seat launch fields: validated native preflight survives the fixed boundary into parent diagnostics', async () => {
  const value = await crossBoundary(Object.assign(new Error('synthetic refusal'), {
    agentLaunchError: { ...preflight, ignored: secret }, env: { PRIVATE_VALUE: secret }, arbitrary: secret,
  }))
  assert.deepEqual(value.agentLaunchError, preflight)
  assert.equal(value.env, undefined)
  assert.equal(value.arbitrary, undefined)
  const details = diagnosticRequestContext({ method: 'POST', url: '/api/bots/bot-a/messages' }, [], value)
  assert.match(details, /native_launch_phase=authentication_preflight/)
  assert.match(details, /native_launch_effect=not_issued/)
  assert.match(details, /native_session_created=false/)
  const invalid = await crossBoundary(Object.assign(new Error('synthetic refusal'), { agentLaunchError: { ...preflight, session_created: true } }))
  assert.equal(invalid.agentLaunchError, undefined)
})

test('seat launch fields: sanitized reportable MCP fields survive while private or invalid records stay excluded', async () => {
  const detail = captureMcpError('pty_send', 'native token=synthetic-token prompt ' + secret, { text: secret })
  const value = await crossBoundary(Object.assign(new Error('synthetic refusal'), { mcp_error: { ...detail, ignored: secret } }))
  assert.deepEqual(value.mcp_error, detail)
  assert.ok(diagnosticRequestContext({ method: 'POST', url: '/api/bots/bot-a/messages' }, [], value)
    .includes('mcp_error=' + JSON.stringify(detail)))
  for (const record of [{ tool: 'agent_launch', message: 'private tool', truncated: false },
    { tool: 'pty_send', message: 'invalid record', truncated: 'false' }]) {
    const invalid = await crossBoundary(Object.assign(new Error('synthetic refusal'), { mcp_error: record }))
    assert.equal(invalid.mcp_error, undefined)
  }
})
