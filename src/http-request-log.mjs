// 書き込み系の要求は、受付の時刻と結果を1行残す。
// 保存が届いたか・応答を返し終えたかを、端末側の時刻と後から照合するため（本文と問い合わせ文字列は残さない）。
// 応答を返し終える前に接続が切れた時は、状態コードの代わりに aborted と書く。
const WRITE_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE'])
export function logWriteRequest(request, response, write) {
  const path = String(request.url).split('?')[0]
  if (!WRITE_METHODS.has(request.method) || !path.startsWith('/api/')) return
  const started = Date.now()
  let finished = false
  response.once('finish', () => { finished = true })
  response.once('close', () => {
    write(`BellTeam write: ${new Date(started).toISOString()} ${request.method} ${path} ${finished ? response.statusCode : 'aborted'} ${Date.now() - started}ms\n`)
  })
}

// 読み取りは受付時にも残す。応答待ちのGETと、記録されなかったGETを区別するため。
// finishは端末の受領ではなく、Nodeが応答をOSへ渡し終えた事を表す。
export function logReadRequest(request, response, write) {
  const path = String(request.url).split('?')[0]
  if (!['GET', 'HEAD'].includes(request.method) || !path.startsWith('/api/')) return
  const started = Date.now()
  const prefix = `BellTeam read: ${new Date(started).toISOString()} ${request.method} ${path}`
  write(`${prefix} started\n`)
  let finished = false
  response.once('finish', () => { finished = true })
  response.once('close', () => {
    write(`${prefix} ${finished ? response.statusCode : 'aborted'} ${Date.now() - started}ms\n`)
  })
}
