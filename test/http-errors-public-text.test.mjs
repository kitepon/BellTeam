import assert from 'node:assert/strict'
import test from 'node:test'
import { respondHttpError } from '../src/http-errors.mjs'

const respond = async error => {
  const out = {}
  await respondHttpError({ url: '/api/harness-auth/claude/start', method: 'POST' }, {
    writeHead(status) { out.status = status }, end(body) { out.body = JSON.parse(body) },
  }, error, null)
  return out
}

test('IPC越しのHARNESS_AUTH_ACCOUNTS_UNAVAILABLEは、文を運ばなくても日本語の案内を返す', async () => {
  // usage子からはError(code)とstatusだけが戻る。
  const out = await respond(Object.assign(new Error('HARNESS_AUTH_ACCOUNTS_UNAVAILABLE'), { code: 'HARNESS_AUTH_ACCOUNTS_UNAVAILABLE', status: 503 }))
  assert.deepEqual(out, { status: 503, body: { error: 'HARNESS_AUTH_ACCOUNTS_UNAVAILABLE',
    message: 'アカウントの保存場所を用意できませんでした。少し待ってから、もう一度お試しください。' } })
})

test('表に無いcodeは従来どおりpublicMessage、無ければerror.messageを返す', async () => {
  assert.equal((await respond(Object.assign(new Error('EXECUTION_REQUEST_INVALID'), { code: 'EXECUTION_REQUEST_INVALID', status: 400 }))).body.message, 'EXECUTION_REQUEST_INVALID')
  assert.equal((await respond(Object.assign(new Error('x'), { code: 'toString', status: 400, publicMessage: '公開文' }))).body.message, '公開文')
  assert.equal((await respond(Object.assign(new Error('x'), { code: 'toString', status: 400 }))).body.message, 'x')
})
