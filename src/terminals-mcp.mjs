// Bot MCP tools for the terminals registry (remote-seat-ingress.md RS09). Validation and projections are the core's.
import { objectSchema, assertKeys } from './mcp-schema.mjs'
import { TERMINALS_UNAVAILABLE } from './http-terminals-api.mjs'

// Descriptions are the AI's only manual (Owner 2026-11-09: 「AIが使い方を間違えないように」). Keys never travel in any argument.
const NO_SECRET = '鍵・パスワード・秘密鍵の中身は、どの引数にもメッセージにも書かない。'
const id = { type: 'string', pattern: '^[a-z0-9][a-z0-9-]{0,63}$', description: '端末ID。英小文字・数字・ハイフンだけ（例 owner-macbook）。登録済みのIDはlist_terminalsで確かめる' }
const fields = {
  terminalId: id,
  host: { type: 'string', minLength: 1, description: '端末のIPアドレスかホスト名だけ（例 192.168.1.12）。user@・ポート・パス・sshオプションは含めない' },
  user: { type: 'string', minLength: 1, description: '端末にログインするユーザー名（例 kite）' },
  port: { type: 'integer', minimum: 1, maximum: 65535, description: 'SSHのポート番号（整数、既定22）' },
  os: { type: 'string', enum: ['macos', 'linux', 'windows'], description: '端末のOS。macos / linux / windows。windowsではフォルダを C:\\Users\\... の形で書き、sudoKeyRefは使えない（管理者のアカウントで登録する）' },
  accountOwner: { type: 'string', enum: ['owner', 'terminal-owner'], description: 'その機械の持ち主。owner=オーナー本人の機械（オーナーのClaudeアカウントを使える）。terminal-owner=ほかの人の機械（その機械のClaudeログインを使い、オーナーのアカウントは渡らない）' },
  confirmHostKey: { type: 'string', pattern: '^SHA256:', description: '任意。ホスト鍵が変わったと言われた時だけ、オーナーが確かめた指紋（SHA256:で始まる）を渡す。一致した時だけ信用し直す。指紋を推測で入れない' },
  sshKeyRef: { type: 'string', description: `任意。秘密入力カードで入れたSSH鍵、または1Passwordの参照から発行された鍵の参照（UUID）だけを渡す。${NO_SECRET}鍵がまだ無ければ省き、あとでbind_terminal_keyで結ぶ` },
  sudoKeyRef: { type: 'string', description: `任意。秘密入力カードか1Passwordの参照から発行されたsudoパスワードの参照（UUID）。${NO_SECRET}` },
}

const ERRORS = 'エラーの意味と次の手: INVALID_TERMINAL=入力の形が違う（メッセージに直す欄と形が書いてある。推測で埋めずに直して呼び直す）。TERMINAL_NOT_FOUND=そのIDは未登録（list_terminalsで確かめる）。HOST_KEY_FINGERPRINT_MISMATCH=指紋が端末と違う（オーナーに指紋を確かめてもらう）。'
export const terminalTools = Object.freeze([
  { name: 'list_terminals', description: '登録済みの端末（リモート席を動かすLANの機械）の一覧。鍵の参照そのものは返さず、設定済みかどうか（sshKeyConfigured）だけを返す。', inputSchema: objectSchema({}) },
  { name: 'register_terminal', description: `端末を登録する。同じterminalIdで呼ぶと、渡した欄だけを更新する。${NO_SECRET}鍵は秘密入力カードか1Passwordの参照で入れ、その参照だけを渡す。${ERRORS}`, inputSchema: objectSchema(fields, ['terminalId']) },
  { name: 'remove_terminal', description: '端末の登録を消す。その端末を使うメンバーの設定と保留中のメッセージは残る（メンバー側の端末IDは自分で直す）。', inputSchema: objectSchema({ terminalId: id }, ['terminalId']) },
  { name: 'check_terminal', description: '端末へSSHで届くかを一度だけ確かめる。席は起動しない。reachable=falseの時のreason: TERMINAL_UNAVAILABLE / UNREACHABLE=端末が眠っているか届かない（起きれば自動で再開する）。CONNECTION_REFUSED=Macが接続を断った（リモートログインがオンか、オーナーに確かめてもらう。断定しない）。CREDENTIAL_UNAVAILABLE / AUTH_FAILED=鍵が無いか使えない、またはMacにまだ入っていないかもしれない（秘密入力カードで鍵を入れ直すか、オーナーにアプリの「このMacにこの鍵を入れる」を頼む。パスワードを聞かない）。HOST_TRUST_MISSING / HOST_KEY_MISMATCH=ホスト鍵を信用していない（actionに従い、オーナーが確かめた指紋をconfirmHostKeyで渡す）。TERMINAL_NOT_FOUND=未登録。', inputSchema: objectSchema({ terminalId: id }, ['terminalId']) },
  { name: 'bind_terminal_key', description: `Aitermが持つSSH鍵の登録（ref、UUID）を登録済みの端末に結び、その端末の鍵として設定する。宛先は端末の登録から取る。${NO_SECRET}先にregister_terminalで端末を登録しておく。`,
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
