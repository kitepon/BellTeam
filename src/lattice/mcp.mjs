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
      '工程を1件足す: ["todo","add","--plan","p1","--task","t23","--title","...","--phase","ph1","--lane","<担当のBot ID>","--after","t10","--design-memo","..."]（計画全体を送り直さない）。' +
      '工程には必ず設計メモ（plan の input では各 task の design_memo、todo add では --design-memo）を書く。空だと DESIGN_MEMO_REQUIRED で断られる。--template のひな形は設計メモが空なので、そのまま送らない。本当に計画が無い時だけ自分で NO_PLAN と書く。1件取り下げる: ["todo","retire","--plan","p1","--task","t23","--reason","..."]。' +
      '作業がぶつからないかの確かめ（witness の計画）で自分の工程が触るファイルを申告する: ["todo","independence","witness","declare","--plan","p1","--task","t23","--owns","src/a.mjs,src/b.mjs","--reads","docs/x.md"]（自分の行だけ書く。全員がそろうと自動で判定し、そろうまでは waiting_for に未申告の工程が出る）。' +
      '待つ印: ["todo","wait","--plan","p1","--task","t23","--reason","..."]。着手できたらすぐ動きたいという意思表示で、付けると、着手できるようになった時に作業中でも割り込んで知らせが届く。割り込まれて構わない時だけ付ける。付けなくても、手が空いていれば1分ごとの見回りが着手を促す（もう着手できる時は startable_now が返る。やめる時は --cancel）。' +
      '迷ったら ["help"] を呼ぶ。着手は todo start のように、誰が何を作っているかが工程表に残る。' +
      'input は JSON ファイルを受け取るコマンド（plan create / plan revise / plan backchain）に渡す JSON オブジェクト。args に --input を書かない（自動で付く）。工程の lane は担当で、メンバーのBot ID（例: bot-09e6225c）を書くと画面に顔と名前が出る。オーナーは owner。lane は英数字と . _ - だけで、日本語の名前は Lattice に断られる（identifier_invalid）。それ以外の英数字はそのまま担当として出る。' +
      '結果は {exitCode, result, stdout, stderr}。result は Lattice 自身の JSON で、断られた時も通常の結果として code と next_action（次にすること。detail.next_action のこともある）が入るので、その指示に従って呼び直す。result が null の時は stdout の文章を読む。',
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
