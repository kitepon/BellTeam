// Codexのhook信頼とApp Server接続。hookの登録そのものは、製品のE1を適用する src/harness-entries.mjs が一つの書き手として行う（bd14）。
// 旧RTK/testgateの書き手（configureRtk）は、RTKが自分のE1を公開する形へ移ったので退役した。
import { spawn } from 'node:child_process'
import { realpath } from 'node:fs/promises'
import { join } from 'node:path'

// Codexは、新しいhookを現在の定義に対する信頼記録があるまで動かさない。公式App Serverの
// hooks/list が示す鍵とhashで、製品が登録したhandlerだけを信頼し、他のhandlerの信頼は変えない。
// 鍵は位置で決まるので、同じ位置でcommandを替えた時は同じ鍵のhashを書き直す。
export async function trustCodexHook(home, hooksFile, withCodexAppServer, env, command) {
  const source = await realpath(hooksFile)
  await withCodexAppServer(env, async request => {
    const list = async () => ((await request('hooks/list', { cwds: [join(home, '.codex')] }))?.data?.[0]?.hooks ?? [])
      .filter(hook => hook.command === command && hook.sourcePath === source)
    const owned = await list()
    if (!owned.length) throw new Error('RTK_CODEX_HOOK_NOT_LISTED')
    const edits = owned.filter(hook => !hook.enabled || hook.trustStatus !== 'trusted').flatMap(hook => {
      if (typeof hook.key !== 'string' || typeof hook.currentHash !== 'string') throw new Error('RTK_CODEX_HOOK_SCHEMA_UNKNOWN')
      const key = `hooks.state.${JSON.stringify(hook.key)}`
      return [
        { keyPath: `${key}.trusted_hash`, value: hook.currentHash, mergeStrategy: 'replace' },
        { keyPath: `${key}.enabled`, value: true, mergeStrategy: 'replace' },
      ]
    })
    if (!edits.length) return
    await request('config/batchWrite', { edits, filePath: join(home, '.codex/config.toml') })
    if ((await list()).some(hook => !hook.enabled || hook.trustStatus !== 'trusted')) throw new Error('RTK_CODEX_HOOK_NOT_TRUSTED')
  })
}

// 公式App Server（`codex app-server`）へstdioでつなぎ、threadもturnも作らずに設定だけを扱う。
export async function codexAppServer(env, use) {
  const child = spawn('codex', ['app-server', '--listen', 'stdio://'], { env, stdio: ['pipe', 'pipe', 'pipe'] })
  let buffer = ''
  let nextId = 0
  const waiting = new Map()
  const fail = error => { for (const { reject } of waiting.values()) reject(error); waiting.clear() }
  child.stderr.resume()
  child.on('error', fail)
  // Messages reach the body log: Codex's stderr and remote error objects can echo config values (tokens), so only codes go out.
  child.on('exit', code => fail(new Error(`CODEX_APP_SERVER_EXITED: ${code}`)))
  child.stdout.on('data', data => {
    buffer += data
    let index
    while ((index = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, index)
      buffer = buffer.slice(index + 1)
      let message
      try { message = JSON.parse(line) } catch { continue }
      const pending = waiting.get(message.id)
      if (!pending) continue
      waiting.delete(message.id)
      if (message.error) pending.reject(new Error(`CODEX_APP_SERVER_ERROR: ${Number.isInteger(message.error?.code) ? message.error.code : '不明'}`))
      else pending.resolve(message.result)
    }
  })
  const request = (method, params) => new Promise((resolve, reject) => {
    const id = ++nextId
    waiting.set(id, { resolve, reject })
    child.stdin.write(`${JSON.stringify({ id, method, params })}\n`)
  })
  try {
    await request('initialize', { clientInfo: { name: 'bellteam', version: '1' }, capabilities: { experimentalApi: true } })
    child.stdin.write(`${JSON.stringify({ method: 'initialized' })}\n`)
    return await use(request)
  } finally {
    child.kill()
  }
}
