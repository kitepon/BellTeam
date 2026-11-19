import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

// a451 train 2: the image carries no AI CLI; the user installs each in AIの認証 (runtime/user-cli-place.md).
test('the server image installs none of the four AI CLIs and keeps an empty bell-owned user place', async () => {
  const dockerfile = await readFile(new URL('../Dockerfile', import.meta.url), 'utf8')
  for (const forbidden of [/@openai\/codex/u, /@anthropic-ai\/claude-code/u, /x\.ai\/cli\/install/u, /cursor\.com\/install/u, /\bcursor-agent\b/u])
    assert.doesNotMatch(dockerfile, forbidden)
  assert.match(dockerfile, /^USER bell\n[\s\S]*?RUN install -d -m 0755 \/home\/bell\/\.local\/bin$/mu)
})
