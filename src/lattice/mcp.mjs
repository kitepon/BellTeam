import { objectSchema } from '../mcp-schema.mjs'

export const latticeTools = [
  {
    name: 'lattice',
    description: '工程表（Lattice）を読み書きする。工程表はプロジェクトごとに一つあり、誰でも開けて、誰でも新しく作れる。統括の工程表に従い、自分用の工程表も作ってよい。' +
      'project は工程表のID（プロジェクトID）で、英小文字・数字・ハイフンのみ、先頭は英小文字か数字、63字まで（例: bellteam）。まだ無いIDを指定すると最初の書き込みで工程表ができる。' +
      'name は画面に出る工程表の名前（1〜40字、例: Lattice組込）。工程表を作る時に付ける。args を [] にすると名前だけ付け直す。画面にIDは出ないので、名前が無いと「作った人の工程表」と表示される。' +
      'args は lattice コマンドの引数で、最初の語は plan, todo, status, session-context, help, --help, --version のいずれか。' +
      '例: ["session-context"]、["status"]、["plan","create","--template","--json"]（plan create の input のひな形。--json が要る）、["todo","start","--plan","p1","--task","t01"]、' +
      '["todo","note","--plan","p1","--task","t01","--message","..."]。' +
      '工程を1件足す: ["todo","add","--plan","p1","--task","t23","--title","...","--lane","<担当のBot ID>","--after","t10"]（計画全体を送り直さない）。1件取り下げる: ["todo","retire","--plan","p1","--task","t23","--reason","..."]。' +
      '迷ったら ["help"] を呼ぶ。着手は todo start のように、誰が何を作っているかが工程表に残る。' +
      'input は JSON ファイルを受け取るコマンド（plan create / plan revise / plan backchain）に渡す JSON オブジェクト。args に --input を書かない（自動で付く）。工程の lane は担当で、メンバーのBot IDか名前（例: bot-09e6225c、キロ）を書くと画面に顔と名前が出る。それ以外の文字はそのまま担当として出る。' +
      '結果は {exitCode, result, stdout, stderr}。result は Lattice 自身の JSON で、断られた時も通常の結果として code と next_action（次にすること）が入るので、その指示に従って呼び直す。result が null の時は stdout の文章を読む。',
    inputSchema: objectSchema({
      project: { type: 'string', pattern: '^[a-z0-9][a-z0-9-]{0,62}$', description: '工程表のID（プロジェクトID）。' },
      name: { type: 'string', minLength: 1, maxLength: 40, description: '画面に出る工程表の名前。省略可。' },
      args: { type: 'array', items: { type: 'string' }, description: 'lattice コマンドの引数。例: ["session-context"]' },
      input: { type: 'object', description: 'plan create などに渡す JSON。省略可。' },
    }, ['project', 'args']),
  },
]

export const latticeToolHandlers = {
  async lattice({ lattice, from, args }) {
    return lattice.run({ from, projectId: args.project, args: args.args, input: args.input ?? null, ...(args.name !== undefined && { name: args.name }) })
  },
}
