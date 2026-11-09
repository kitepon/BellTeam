// Bot MCP tools for the terminals registry (remote-seat-ingress.md RS09). Validation and projections are the core's.
import { objectSchema, assertKeys } from './mcp-schema.mjs'
import { TERMINALS_UNAVAILABLE } from './http-terminals-api.mjs'

const id = { type: 'string', pattern: '^[a-z0-9][a-z0-9-]{0,63}$' }
const fields = {
  terminalId: id,
  host: { type: 'string', minLength: 1 },
  user: { type: 'string', minLength: 1 },
  port: { type: 'integer', minimum: 1, maximum: 65535 },
  os: { type: 'string', enum: ['macos'] },
  accountOwner: { type: 'string', enum: ['owner', 'terminal-owner'] },
  ingressUrl: { type: ['string', 'null'], description: 'この端末の席が使うBellTeamの入口。SSH逆転送の端末ではAitermが端末ごとの口へ置き換えるので、どのhttpでもよい（例 http://127.0.0.1:4182）。nullで消す' },
  confirmHostKey: { type: 'string', pattern: '^SHA256:', description: '任意。端末のホスト鍵の指紋を確かめて信用する' },
  sshKeyRef: { type: 'string', description: '秘密入力（ミカ）が発行した鍵の参照。鍵の値は渡さない' },
  sudoKeyRef: { type: 'string', description: '任意。秘密入力が発行したsudo鍵の参照' },
}

export const terminalTools = Object.freeze([
  { name: 'list_terminals', description: '登録済みの端末（遠隔席を動かすLANの機械）の一覧。秘密の値は含まない。', inputSchema: objectSchema({}) },
  { name: 'register_terminal', description: '端末を登録または更新する。鍵は秘密入力の参照だけを渡す。', inputSchema: objectSchema(fields, ['terminalId']) },
  { name: 'remove_terminal', description: '端末の登録を消し、その端末への接続を閉じる。', inputSchema: objectSchema({ terminalId: id }, ['terminalId']) },
  { name: 'check_terminal', description: '端末へ届くかを一度確かめる。席は起動しない。', inputSchema: objectSchema({ terminalId: id }, ['terminalId']) },
  { name: 'bind_terminal_key', description: 'Aitermが持つSSH鍵の参照（ref）を登録済みの端末に結び、その端末の鍵として設定する。宛先は端末の登録から取る。鍵の値は扱わない。',
    inputSchema: objectSchema({ terminalId: id, ref: { type: 'string', pattern: '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' } }, ['terminalId', 'ref']) },
])

export function createTerminalKeys({ terminals, credentials }) {
  return Object.freeze({
    async bind({ terminalId, ref }) {
      const terminal = await terminals.registry.get(terminalId)
      if (!terminal) throw Object.assign(new Error('TERMINAL_NOT_FOUND'), { code: 'TERMINAL_NOT_FOUND', status: 404 })
      const credential = await credentials.registerNative({ ref, target: { host: terminal.host, user: terminal.user, port: terminal.port } }, { terminalId, purpose: 'terminal.ssh' })
      return { credential, terminal: await terminals.registry.put({ terminalId, sshKeyRef: credential.handle }) }
    }
  })
}

export async function callTerminalTool({ name, args = {}, terminals, terminalKeys }) {
  const core = terminals?.()
  if (!core) throw TERMINALS_UNAVAILABLE()
  if (name === 'bind_terminal_key') {
    assertKeys(args, ['terminalId', 'ref'])
    const keys = terminalKeys?.()
    if (!keys) throw Object.assign(new Error('Native credentials unavailable'), { code: 'CREDENTIAL_UNAVAILABLE', status: 503 })
    return keys.bind(args)
  }
  if (name === 'list_terminals') { assertKeys(args, []); return { terminals: await core.registry.list() } }
  if (name === 'register_terminal') { assertKeys(args, Object.keys(fields)); return { terminal: await core.registry.put(args) } }
  assertKeys(args, ['terminalId'])
  if (name === 'remove_terminal') return core.registry.remove(args.terminalId)
  return core.reachability.check(args.terminalId)
}
