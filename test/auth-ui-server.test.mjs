import { strict as assert } from 'node:assert'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { networkInterfaces } from 'node:os'
import test from 'node:test'

const start = async env => {
  const child = spawn(process.execPath, ['test/helpers/auth-ui-server.mjs'], {
    env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'inherit'],
  })
  const [line] = await once(child.stdout, 'data')
  return { child, url: JSON.parse(line).url }
}
const stop = async child => { child.kill(); await once(child, 'exit') }
const lanAddress = Object.values(networkInterfaces()).flat().find(item => item.family === 'IPv4' && !item.internal)?.address

test('既定はローカルだけで待ち受ける', async () => {
  const { child, url } = await start({ AUTH_UI_FIXTURE_HOST: undefined })
  try {
    assert.match(url, /^http:\/\/127\.0\.0\.1:\d+$/u)
    assert.equal((await fetch(`${url}/test/reset`)).status, 200)
    if (lanAddress) await assert.rejects(fetch(url.replace('127.0.0.1', lanAddress) + '/test/reset'))
  } finally { await stop(child) }
})

test('指定したLANアドレスで待ち受け、同じ値をURLに返す', { skip: lanAddress ? false : 'LANアドレスが無い' }, async () => {
  const { child, url } = await start({ AUTH_UI_FIXTURE_HOST: lanAddress })
  try {
    assert.equal(new URL(url).hostname, lanAddress)
    assert.equal((await fetch(`${url}/test/reset`)).status, 200)
    await assert.rejects(fetch(url.replace(lanAddress, '127.0.0.1') + '/test/reset'))
  } finally { await stop(child) }
})
