#!/usr/bin/env node
// a492: a DEVELOPMENT server for the login first run (not a product, not on a train). It mounts the same two modules the BellTeam
// server mounts for the login-billing home part: the usage child's home-login and the body's home-login-front, with the child call in-process.
// Reachable over plain http on the home network. A protected GET /api/me stands in for "the owner API" so an app can see the 401.
//   BELLTEAM_HOME_OPERATOR=<operator wire base> node scripts/dev-home-server.mjs [--port 18893] [--dir <state dir>]
import { createServer } from 'node:http'
import { join } from 'node:path'
import { createHomeLogin } from '../src/usage/home-login.mjs'
import { createHomeFront } from '../src/home-login-front.mjs'

const option = name => { const at = process.argv.indexOf(`--${name}`); return at > 0 ? process.argv[at + 1] : undefined }
const port = Number(option('port') ?? 18893)
const dir = option('dir') ?? join(process.cwd(), 'home-dev-state')
const operator = process.env.BELLTEAM_HOME_OPERATOR
if (!operator) { process.stderr.write('BELLTEAM_HOME_OPERATOR (the operator wire base, e.g. https://host/auth/v1) is required\n'); process.exit(2) }

const home = createHomeLogin({ path: join(dir, 'login-home.json'), operator })
const methods = {
  'home.handle': params => home.handle(params), 'home.sweep': params => home.sweep(params), 'home.setupCode': () => home.setupCode(),
  'home.publish': () => home.publish(), 'home.console': params => home.console(params),
}
const front = createHomeFront({ call: (name, params) => methods[name](params), markerPath: join(dir, 'login-enforced') })

const send = (response, status, body) => { response.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' }); response.end(JSON.stringify(body)) }
// One line per request for the people who record the first run: time, peer, method, path, status and, for a refusal, its error code.
// Never a header, a body, a token or a code.
const log = (request, response, started) => {
  let error = ''
  const end = response.end.bind(response)
  response.end = (chunk, ...rest) => { if (response.statusCode >= 400 && typeof chunk === 'string') { try { error = ` ${JSON.parse(chunk).error ?? ''}` } catch {} } return end(chunk, ...rest) }
  response.on('finish', () => process.stderr.write(`${new Date().toISOString()} ${request.socket.remoteAddress} ${request.method} ${request.url.split('?')[0]} ${response.statusCode}${error} ${Date.now() - started}ms\n`))
}
const server = createServer(async (request, response) => {
  log(request, response, Date.now())
  const url = new URL(request.url, 'http://dev')
  try {
    if (request.method === 'GET' && url.pathname === '/healthz') return send(response, 200, { ok: true })
    if (await front.route(request, response, url)) return
    const who = await front.judge(request.headers)
    if (who === 'unavailable') return send(response, 503, { error: 'SESSION_STORE_UNAVAILABLE' })
    if (request.method === 'GET' && url.pathname === '/api/session') return send(response, 200, { authenticated: who === 'legacy' || Boolean(who.sessionId), authMode: 'local' })
    if (who === 'none') return send(response, 401, { error: 'UNAUTHORIZED' })
    if (request.method === 'GET' && url.pathname === '/api/me') return send(response, 200, { sessionId: who.sessionId ?? null, entitlementState: front.stateOf(who.sessionId) ?? null })
    return send(response, 404, { error: 'NOT_FOUND' })
  } catch { return send(response, 500, { error: 'INTERNAL' }) }
})
await front.listenConsole(join(dir, 'console.sock'))
await front.start()
server.listen(port, '0.0.0.0', () => process.stderr.write(`BellTeam dev home server on :${port}, state ${dir}, console socket ${join(dir, 'console.sock')}\n`))
