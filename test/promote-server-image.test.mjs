import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { verifyCandidate, promoteCandidate } from '../scripts/promote-server-image.mjs'

const image = 'ghcr.io/kitepon/bellteam-server'
const source = 'a'.repeat(40)
const hash = raw => `sha256:${createHash('sha256').update(raw).digest('hex')}`
function registry({ arches = ['amd64', 'arm64'], revision = source } = {}) {
  const values = new Map()
  const config = JSON.stringify({ config: { Labels: { 'org.opencontainers.image.revision': revision } } })
  values.set(`blobs/${hash(config)}`, config)
  const manifests = arches.map(architecture => {
    const raw = JSON.stringify({ config: { digest: hash(config) }, architecture })
    const digest = hash(raw)
    values.set(`manifests/${digest}`, raw)
    return { digest, platform: { os: 'linux', architecture } }
  })
  const raw = JSON.stringify({ manifests })
  const digest = hash(raw)
  values.set(`manifests/${digest}`, raw)
  const get = async url => {
    if (url.startsWith('https://ghcr.io/token?')) return new Response(JSON.stringify({ token: 'fixture' }))
    const key = url.split('/v2/kitepon/bellteam-server/')[1]
    return values.has(key) ? new Response(values.get(key)) : new Response('', { status: 404 })
  }
  return { raw, digest, get }
}

test('内部で使ったindexと両archのsourceを照合し、同一digestだけを安定タグへ渡す', async () => {
  const r = registry()
  const candidate = await verifyCandidate({ image, digest: r.digest, source, result: '合成内部受入記録', fetch: r.get })
  const calls = []
  await promoteCandidate(candidate, { summary: null, run: (command, args) => {
    calls.push([command, ...args])
    return args.includes('--raw') ? r.raw : ''
  } })
  assert.deepEqual(calls[0], ['docker', 'buildx', 'imagetools', 'create', '-t', `${image}:latest`, '-t', `${image}:preview`, `${image}@${r.digest}`])
  assert.deepEqual(calls.slice(1), ['latest', 'preview'].map(tag => ['docker', 'buildx', 'imagetools', 'inspect', '--raw', `${image}:${tag}`]))
})

test('別sourceや片arch、未取得のindexを内部受入済みとして扱わない', async () => {
  for (const options of [{ revision: 'b'.repeat(40) }, { arches: ['amd64'] }]) {
    const r = registry(options)
    await assert.rejects(verifyCandidate({ image, digest: r.digest, source, result: '合成記録', fetch: r.get }))
  }
  const r = registry()
  await assert.rejects(verifyCandidate({ image, digest: `sha256:${'0'.repeat(64)}`, source, result: '合成記録', fetch: r.get }))
  await assert.rejects(verifyCandidate({ image, digest: r.digest, source, result: ' ', fetch: r.get }))
})

test('反映後のタグが受入digestと異なる場合は成功にしない', async () => {
  const r = registry()
  await assert.rejects(promoteCandidate({ digest: r.digest, source, result: '合成記録' }, {
    summary: null, run: (_command, args) => args.includes('--raw') ? '{}' : '',
  }))
})
