// 内部で受け入れた公開候補を、再buildせず安定タグへ反映する。
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { appendFile } from 'node:fs/promises'
import { execFileSync } from 'node:child_process'
import { pathToFileURL } from 'node:url'

export async function verifyCandidate({ image, digest, source, result, fetch: get = fetch }) {
  assert.equal(image, 'ghcr.io/kitepon/bellteam-server')
  assert.match(digest ?? '', /^sha256:[0-9a-f]{64}$/)
  assert.match(source ?? '', /^[0-9a-f]{40}$/)
  assert.ok(result?.trim(), '内部先行受入の結果を指定してください')
  const tokenResponse = await get('https://ghcr.io/token?service=ghcr.io&scope=repository:kitepon/bellteam-server:pull')
  assert.equal(tokenResponse.status, 200)
  const { token } = await tokenResponse.json()
  const headers = { Authorization: `Bearer ${token}`, Accept: 'application/vnd.oci.image.index.v1+json, application/vnd.docker.distribution.manifest.list.v2+json, application/vnd.oci.image.manifest.v1+json, application/vnd.docker.distribution.manifest.v2+json' }
  const read = async path => {
    const response = await get(`https://ghcr.io/v2/kitepon/bellteam-server/${path}`, { headers })
    assert.equal(response.status, 200)
    const raw = await response.text()
    return { value: JSON.parse(raw), digest: `sha256:${createHash('sha256').update(raw).digest('hex')}` }
  }
  const index = await read(`manifests/${digest}`)
  assert.equal(index.digest, digest)
  assert.deepEqual(index.value.manifests.map(m => `${m.platform.os}/${m.platform.architecture}`).sort(), ['linux/amd64', 'linux/arm64'])
  for (const entry of index.value.manifests) {
    const manifest = await read(`manifests/${entry.digest}`)
    assert.equal(manifest.digest, entry.digest)
    const config = await read(`blobs/${manifest.value.config.digest}`)
    assert.equal(config.digest, manifest.value.config.digest)
    assert.equal(config.value.config.Labels['org.opencontainers.image.revision'], source)
  }
  return { digest, source, result }
}

export async function promoteCandidate(candidate, { run = execFileSync, summary = process.env.GITHUB_STEP_SUMMARY } = {}) {
  const image = 'ghcr.io/kitepon/bellteam-server'
  run('docker', ['buildx', 'imagetools', 'create', '-t', `${image}:latest`, '-t', `${image}:preview`, `${image}@${candidate.digest}`], { stdio: 'inherit' })
  for (const tag of ['latest', 'preview']) {
    const raw = run('docker', ['buildx', 'imagetools', 'inspect', '--raw', `${image}:${tag}`], { encoding: 'utf8' })
    assert.equal(`sha256:${createHash('sha256').update(raw).digest('hex')}`, candidate.digest)
  }
  if (summary) await appendFile(summary, `## 内部受入済みの同一imageを反映\n\nsource: ${candidate.source}\n\ndigest: ${candidate.digest}\n\n受入記録: ${candidate.result}\n`)
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const candidate = await verifyCandidate({ image: process.env.IMAGE, digest: process.env.ACCEPTED_DIGEST, source: process.env.ACCEPTED_SOURCE, result: process.env.ACCEPTANCE_RESULT })
  execFileSync('git', ['merge-base', '--is-ancestor', candidate.source, 'origin/main'])
  assert.ok(['check', 'promote'].includes(process.argv[2]))
  if (process.argv[2] === 'promote') await promoteCandidate(candidate)
  else console.log(JSON.stringify({ digest: candidate.digest, source: candidate.source }))
}
