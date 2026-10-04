import product from './product.json' with { type: 'json' }
import compose from '../../distribution/server/compose.yaml'
import installer from '../../distribution/server/install.sh'
import environmentExample from '../../distribution/server/.env.example'
import instructions from '../../distribution/server/README.md'
import onboardingInstructions from '../../docs/onboarding.md'

const serverFiles = new Map([
  ['/server/compose.yaml', compose],
  ['/server/install.sh', installer],
  ['/server/.env.example', environmentExample],
  ['/server/README.md', instructions],
  ['/server/docs/onboarding.md', onboardingInstructions],
])

const privacyBody = `<h1>BellTeam プライバシー方針</h1>
<h2>会話とAIの設定</h2>
<p>BellTeamは、利用者が設置するサーバーと、その利用者が契約するAIサービスへ接続するアプリです。会話、添付画像、メンバーのプロフィール、予定、AIの認証情報は利用者のサーバーで管理します。BellTeamの購読確認サービスへ会話やAIの認証情報を送ることはありません。</p>
<p>サーバーの接続先とログイン状態は利用する端末へ保存します。写真やファイルは、利用者が会話へ添付するために選んだものを、自分のサーバーへ送信します。AIへ渡す会話などの情報は、利用者が選んだAIサービスの規約と方針に従って取り扱われます。</p>
<h2>購読の確認</h2>
<p>購入と支払いはAppleが処理します。BellTeamの運営はカード番号やApple Accountのパスワードを受け取りません。</p>
<p>Appleアプリは端末本人の購入権利をStoreKitで確認します。利用者のサーバーは、Appleの署名付き購入情報をCloudflareで動くBellTeamの購読確認サービスへ送ります。このサービスはAppleから取引ID、商品、更新状態、有効期限などを照会し、Appleアプリの購入と通知の利用権を検証します。Webとサーバーは無料で、購読による利用制限はありません。購読情報を運営のデータベースへ保存しません。利用者のサーバーには復元・利用権の確認に必要な購入情報と確認結果が残ります。</p>
<p>購読確認サービスの稼働確認には、Cloudflareの処理ログと集計情報を使います。購入情報の本文を独自のログへ記録しません。Cloudflareの処理ログには、接続元のIPアドレス、IPから推定した位置（市、郵便番号、緯度・経度など）、端末・ブラウザの種類、アクセスURL、通信と実行の識別子、応答と処理時間が保存されます。位置は通信に伴うIPからの推定で、端末のGPSを取得する機能はありません。これらは稼働確認と障害の調査に使い、広告配信や追跡には使いません。ログの保管とインフラ上の処理は、<a href="https://www.cloudflare.com/privacypolicy/">Cloudflareのプライバシー方針</a>と<a href="https://developers.cloudflare.com/workers/observability/logs/workers-logs/">Workers Logsの方針</a>に従います。</p>
<h2>通知と診断</h2>
<p>通知を登録した場合、端末の通知トークンと本人の署名付き購入情報を利用者のサーバーへ保存します。運営の通知送信サービスを使う設定では、端末の通知トークン、接続先、メンバー・ルームの名前、会話を開くための識別子と定型の案内を運営へ送ります。利用権の確認には通知先端末のAppleの署名付き購入情報を使います。通知の配信にはAppleのAPNsを使います。会話本文と入力した秘密の値は通知へ含めません。端末の設定から通知を停止できます。</p>
<p>通信エラー、クラッシュや応答停止などの診断は利用者のサーバーへ送ります。診断にはアプリの版、エラーの種類、呼び出し履歴などを含みます。会話本文、秘密の値、購入情報の本文を診断用に収集しません。サーバーの管理者が外部の診断管理サービスと連携した場合、その管理者の設定で共有されます。</p>
<h2>保持と削除</h2>
<p>購読の終了だけでは利用者のサーバーにあるデータを削除しません。保存済みの会話は引き続き閲覧でき、メンバー・ルームごとにJSONで書き出せます。画像本体は書き出しに含まず、サーバー内の参照URLを含みます。</p>
<p>サーバーのデータとバックアップは、そのサーバーの管理者が保持・削除します。端末のログアウトでログイン情報を消去できます。アプリを削除しても、サーバーとAppleに残るデータや購読契約は削除・解約されません。購読の管理と解約はAppleの購読設定から行ってください。</p>
<p>BellTeamは広告配信や他社アプリをまたぐ追跡のためにデータを使用しません。</p>
<h2>お問い合わせ</h2>
<p><a href="mailto:${product.supportEmail}">${product.supportEmail}</a></p>`

const supportBody = `<h1>BellTeam サポート</h1>
<p>BellTeamは、自分のマシンで動くAIチームと、iPhone・Macから会話するアプリです。Dockerを使えるマシンへ設置し、自分が契約するAIサービスを使います。</p>
<h2>サーバーの設置</h2>
<p>Dockerイメージと設置用ファイルを配布します。アプリはTestFlightで試験中です。<a href="/server/README.md">設置手順</a>を読み、同じフォルダへ<a href="/server/compose.yaml">compose.yaml</a>、<a href="/server/install.sh">install.sh</a>、<a href="/server/.env.example">.env.example</a>を保存してください。</p>
<p>追加機能の設定や.envの作成は不要です。起動後の画面で最初に使うAIを選び、公式サイトで認証すると、案内役が会話で初期設定を進めます。同じマシンやLANから直接接続できます。詳しい仕様は<a href="/server/docs/onboarding.md">初回設定と追加機能</a>を参照してください。</p>
<h2>お問い合わせ</h2>
<p><a class="contact" href="mailto:${product.supportEmail}">${product.supportEmail}</a></p>
<p>困っている操作、iPhoneまたはMacのOSとアプリの版、表示されたエラーをお知らせください。パスワード、認証コード、APIキー、Appleの購入情報、個人の会話本文をメールへ添付する必要はありません。</p>
<h2>購読について</h2>
<p>Webアプリと自分で設置するサーバーは無料です。すべてのメンバーとの会話、メンバー間の配送、予定の実行を購読なしで使えます。AI各社や外部サービスの契約は自分で用意します。</p>
<p>iPhone・Macアプリからの通常の会話と予定操作は月300円の共通購読を使います。案内役との初期設定の会話、閲覧・書き出し・管理は無料です。Webで使ってからAppleアプリの購入を選べます。Appleの購入画面で承認した時に契約が始まり、台数制限はありません。</p>
<p>同じApple Accountでアプリにサインインし、設定の「BellTeamの購読」から「購入を復元」を実行できます。期限が切れた後も、Appleアプリで保存済みの会話の閲覧とJSON書き出しを利用でき、Webの会話と設定済みの予定は動き続けます。</p>
<p>解約や自動更新の停止は、<a href="https://apps.apple.com/account/subscriptions">Appleの購読設定</a>から行ってください。アプリの削除だけでは解約されません。</p>
<p><a href="${product.privacyPolicyUrl}">プライバシー方針</a> · <a href="https://www.apple.com/legal/internet-services/itunes/dev/stdeula/">利用規約（Apple標準）</a></p>`

function document(title, body) {
  return `<!doctype html><html lang="ja"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${title}</title><style>body{margin:0;background:#f5f7fa;color:#202a35;font:16px/1.85 system-ui,sans-serif}main{max-width:760px;margin:32px auto;padding:28px 32px;background:white;border-radius:16px}h1{font-size:27px;line-height:1.5}h2{font-size:20px;margin-top:32px}a{color:#1455a3;overflow-wrap:anywhere}.contact{font-size:20px}nav{font-size:14px;margin-bottom:24px}@media(max-width:560px){main{margin:12px;padding:20px;border-radius:12px}h1{font-size:24px}}</style></head><body><main><nav><a href="${product.supportUrl}">サポート</a> · <a href="${product.privacyPolicyUrl}">プライバシー方針</a></nav>${body}</main></body></html>`
}

export function publicPageResponse(request) {
  const path = new URL(request.url).pathname
  if (!['/', '/support', '/privacy'].includes(path) && !serverFiles.has(path)) return null
  if (!['GET', 'HEAD'].includes(request.method)) return new Response('GETを使ってください。', { status: 405, headers: { Allow: 'GET, HEAD' } })
  if (serverFiles.has(path)) return new Response(request.method === 'HEAD' ? null : serverFiles.get(path), {
    headers: { 'Content-Type': 'text/plain; charset=utf-8', 'Content-Disposition': `attachment; filename="${path.split('/').at(-1)}"` },
  })
  if (path === '/') return Response.redirect(product.supportUrl, 302)
  const title = path === '/privacy' ? 'BellTeam プライバシー方針' : 'BellTeam サポート'
  return new Response(request.method === 'HEAD' ? null : document(title, path === '/privacy' ? privacyBody : supportBody), {
    headers: { 'Content-Type': 'text/html; charset=utf-8' },
  })
}
