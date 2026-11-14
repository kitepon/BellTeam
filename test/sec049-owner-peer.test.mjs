import assert from 'node:assert/strict'
import { once } from 'node:events'
import { createServer } from 'node:http'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { createHttpGateway, socketPeer } from '../src/http-gateway.mjs'
import { createApplicationFeatures } from '../src/usage/application-features.mjs'

const own = String(process.getuid())
const features = cloudflare => createApplicationFeatures({ services: { settings: { configuration: () => cloudflare
  ? { enabled: true, teamDomain: 'team.example', audience: 'aud', keySet: async () => { throw new Error('unused') } }
  : { enabled: false } } }, home: '/nonexistent', callBridgeHeaders: '/nonexistent' })
const request = (host, peer, uid) => ({ headers: { host, ...(peer === undefined ? {} : { 'x-bellteam-peer': peer }), ...(uid === undefined ? {} : { 'x-bellteam-peer-uid': uid }) } })

test('SEC-049: Cloudflare有効時、内側のHostを名乗るだけではオーナーにならない', async () => {
  const { authMode, authorize } = features(true)
  const cases = [
    [request('192.168.1.10:18891'), 'local'], // 旧gateway・非公開socketの直接呼び出しは従来どおり
    [request('192.168.1.10:18891', '192.168.1.20'), 'local'], // LANのアプリ
    [request('mac.local', '172.18.0.1'), 'local'], // 同じマシン（Dockerの橋渡し）
    [request('main-server', '172.18.0.2', '4242'), 'cloudflare'], // コンテナ内のBot席
    [request('127.0.0.1', '127.0.0.1', 'unknown'), 'cloudflare'],
    [request('127.0.0.1', '127.0.0.1', own), 'local'], // docker execの本体ユーザー（通話橋の取込み）
    [request('localhost', '203.0.113.9'), 'cloudflare'], // 外のネットからHostを偽る
    [request('bellteam.example.com', '192.168.1.20'), 'cloudflare'],
  ]
  for (const [input, mode] of cases) {
    assert.equal(authMode(input), mode, JSON.stringify(input.headers))
    assert.equal(await authorize(input), mode === 'local', JSON.stringify(input.headers))
  }
})

test('SEC-049: Cloudflare無効でも、コンテナ内の別ユーザーはオーナーにならない', async () => {
  const { authorize } = features(false)
  assert.equal(await authorize(request('127.0.0.1', '127.0.0.1', '4242')), false)
  assert.equal(await authorize(request('127.0.0.1', '127.0.0.1', own)), true)
  assert.equal(await authorize(request('203.0.113.9', '203.0.113.9')), true) // 直接接続の公開サーバーは従来どおり
})

test('SEC-049: 受付は/proc/net/tcpから相手のユーザーを読み、読めない・曖昧ならunknown', async () => {
  const socket = { remoteAddress: '127.0.0.1', remotePort: 40000, localAddress: '127.0.0.1', localPort: 4180 }
  const row = uid => `   1: 0100007F:9C40 0100007F:1054 01 00000000:00000000 00:00000000 00000000  ${uid}        0 1 1`
  const header = '  sl  local_address rem_address   st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode'
  assert.deepEqual(await socketPeer(socket, async () => `${header}\n${row(1000)}\n`), { 'x-bellteam-peer': '127.0.0.1', 'x-bellteam-peer-uid': '1000' })
  assert.deepEqual(await socketPeer(socket, async () => `${header}\n${row(1000)}\n${row(1001)}\n`), { 'x-bellteam-peer': '127.0.0.1', 'x-bellteam-peer-uid': 'unknown' })
  assert.deepEqual(await socketPeer({ ...socket, remoteAddress: '192.168.1.20' }, async () => `${header}\n${row(1000)}\n`), { 'x-bellteam-peer': '192.168.1.20' })
  assert.deepEqual(await socketPeer(socket, async () => { throw new Error('ENOENT') }), { 'x-bellteam-peer': '127.0.0.1', 'x-bellteam-peer-uid': 'unknown' })
})

test('SEC-049: 受付は利用者が送った相手名を捨て、実際の相手と自分のユーザーを渡す', { skip: process.platform !== 'linux' }, async t => {
  const root = await mkdtemp(join(tmpdir(), 'bellteam-sec049-'))
  const socketPath = join(root, 'public.sock')
  const seen = []
  const upstream = createServer((incoming, response) => { seen.push(incoming.headers); response.end('{}') })
  upstream.listen(socketPath); await once(upstream, 'listening')
  const gateway = createHttpGateway({ socketPath, staticRoot: root })
  gateway.server.listen(0, '127.0.0.1'); await once(gateway.server, 'listening')
  t.after(async () => { await gateway.close(); upstream.close(); await rm(root, { recursive: true, force: true }) })
  await (await fetch(`http://127.0.0.1:${gateway.server.address().port}/api/settings`, {
    headers: { 'x-bellteam-peer': '192.168.1.20', 'x-bellteam-peer-uid': '0' } })).text()
  assert.equal(seen[0]['x-bellteam-peer'], '127.0.0.1')
  assert.equal(seen[0]['x-bellteam-peer-uid'], own)
})
