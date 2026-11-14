import test from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createServer } from 'node:http'

const script = new URL('../scripts/import-call-bridge.mjs', import.meta.url).pathname
const token = 'tok-SECRET-123'
const exported = JSON.stringify({ schema: 'call-bridge.connection.v1', url: 'http://192.168.1.2:18910/mcp', token })

function run(input, port) {
  return new Promise(resolve => {
    const child = spawn(process.execPath, [script], { env: { ...process.env, BELLTEAM_WEB_PORT: String(port) } })
    let out = ''
    child.stdout.on('data', chunk => { out += chunk }); child.stderr.on('data', chunk => { out += chunk })
    child.on('close', code => resolve({ code, out }))
    child.stdin.end(input)
  })
}

test('the export goes to the running server as one loopback PATCH; bad input never reaches it; the token is never printed', async () => {
  const seen = []
  let status = 200
  const server = createServer((request, response) => {
    let body = ''
    request.on('data', chunk => { body += chunk })
    request.on('end', () => {
      seen.push([request.method, request.url, request.headers.host.split(':')[0], JSON.parse(body)])
      response.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify(status === 200 ? { setting: {} } : { error: 'FEATURE_INPUT_INVALID' }))
    })
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address()
  try {
    const ok = await run(exported, port)
    assert.equal(ok.code, 0)
    assert.deepEqual(seen, [['PATCH', '/api/settings/callBridge', '127.0.0.1', { enabled: true, values: { url: 'http://192.168.1.2:18910/mcp', token } }]])
    for (const [input, code] of [['{"schema":"x"}', 'CALL_BRIDGE_IMPORT_INVALID'], ['x'.repeat(64 * 1024 + 1), 'CALL_BRIDGE_IMPORT_TOO_LARGE']]) {
      const bad = await run(input, port)
      assert.equal(bad.code, 1)
      assert.equal(bad.out.trim(), code)
    }
    status = 400
    const refused = await run(exported, port)
    assert.equal(refused.code, 1)
    assert.equal(refused.out.trim(), 'CALL_BRIDGE_IMPORT_REFUSED 400 FEATURE_INPUT_INVALID')
    assert.equal(seen.length, 2, 'invalid and oversized input never reached the server')
    for (const result of [ok, refused]) assert.ok(!result.out.includes(token))
  } finally { server.close() }
})
