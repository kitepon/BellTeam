import { objectSchema } from '../mcp-schema.mjs'

export const latticeTools = [
  {
    name: 'lattice',
    description: '工程表（Lattice）を読み書きする。工程表はプロジェクトごとに一つあり、誰でも開けて、誰でも新しく作れる。統括の工程表に従い、自分用の工程表も作ってよい。' +
      'project は工程表の名前（プロジェクトID）で、英小文字・数字・ハイフンのみ、先頭は英小文字か数字、63字まで（例: bellteam）。まだ無い名前を指定すると最初の書き込みで工程表ができる。' +
      'args は lattice コマンドの引数で、最初の語は plan, todo, status, session-context, help, --help, --version のいずれか。' +
      '例: ["session-context"]、["status"]、["plan","create","--template"]、["todo","start","--plan","p1","--task","t01"]、' +
      '["todo","note","--plan","p1","--task","t01","--message","..."]。' +
      '迷ったら ["help"] を呼ぶ。着手は todo start のように、誰が何を作っているかが工程表に残る。' +
      'input は JSON ファイルを受け取るコマンド（plan create / plan revise / plan backchain）に渡す JSON オブジェクト。args に --input を書かない（自動で付く）。' +
      '結果は {exitCode, result, stdout, stderr}。result は Lattice 自身の JSON で、断られた時も通常の結果として code と next_action（次にすること）が入るので、その指示に従って呼び直す。result が null の時は stdout の文章を読む。',
    inputSchema: objectSchema({
      project: { type: 'string', pattern: '^[a-z0-9][a-z0-9-]{0,62}$', description: '工程表の名前（プロジェクトID）。' },
      args: { type: 'array', items: { type: 'string' }, description: 'lattice コマンドの引数。例: ["session-context"]' },
      input: { type: 'object', description: 'plan create などに渡す JSON。省略可。' },
    }, ['project', 'args']),
  },
]

export const latticeToolHandlers = {
  async lattice({ lattice, from, args }) {
    return lattice.run({ from, projectId: args.project, args: args.args, input: args.input ?? null })
  },
}
