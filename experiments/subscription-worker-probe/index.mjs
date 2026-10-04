import report from './report.json' with { type: 'json' }
import setup from '../../docs/subscription-setup.json' with { type: 'json' }
import product from '../../services/subscriptions/product.json' with { type: 'json' }
import { appleLibraryProbe } from './apple-library-probe.mjs'
import { appleNativeClientProbe } from './apple-native-client-probe.mjs'
import { appleNativeVerifierProbe } from './apple-native-verifier-probe.mjs'
export { SubscriptionVerificationProbe } from './durable-object-probe.mjs'

// CPU計測専用の公開試験鍵。実際の購読情報やAppleの鍵は扱わない。
const privateJwk = {
  key_ops: ['sign'], ext: true, kty: 'EC', crv: 'P-256',
  x: 'N3ecqhRljPzAVfE5ATskaWEcnbN6_ikdCkbGjIKinjk',
  y: 'Yt9jPklnXALjqOkN7xF6Cr9ZcCz-qwkZlRvrWA7itHE',
  d: 'dU8ko-xxa9cEY1J_RgQmOShyd2Bo-_odPWG-397e4zI',
}
const publicJwk = {
  key_ops: ['verify'], ext: true, kty: 'EC', crv: 'P-256',
  x: privateJwk.x, y: privateJwk.y,
}

const keys = Promise.all([
  crypto.subtle.importKey('jwk', privateJwk, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign']),
  crypto.subtle.importKey('jwk', publicJwk, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['verify']),
])
const encoder = new TextEncoder()

function base64url(bytes) {
  return btoa(String.fromCharCode(...bytes)).replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', '')
}

export default {
  async fetch(request, env) {
    const path = new URL(request.url).pathname
    if (request.method === 'GET' && path === '/durable-object-probe') {
      return env.VERIFICATION_PROBE.getByName('public-verification-probe').fetch(request)
    }
    if (request.method === 'GET' && path === '/') {
      return new Response(renderReport(), { headers: { 'Content-Type': 'text/html; charset=utf-8' } })
    }
    if (request.method === 'GET' && path === '/report.json') return Response.json(report)
    if (request.method === 'GET' && path === '/apple-library-probe') return Response.json(await appleLibraryProbe())
    if (request.method === 'GET' && path === '/apple-native-client-probe') return Response.json(await appleNativeClientProbe())
    if (request.method === 'GET' && path === '/apple-native-verifier-probe') return Response.json(await appleNativeVerifierProbe())
    if (request.method !== 'GET' || path !== '/probe') {
      return new Response('見つかりません', { status: 404 })
    }

    const [privateKey, publicKey] = await keys
    const header = base64url(encoder.encode(JSON.stringify({ alg: 'ES256', kid: 'probe' })))
    const now = Math.floor(Date.now() / 1000)
    const payload = base64url(encoder.encode(JSON.stringify({
      iss: 'probe', aud: 'appstoreconnect-v1', iat: now, exp: now + 300, bid: 'dev.example.bellteam.probe',
    })))
    const signedData = encoder.encode(`${header}.${payload}`)
    const signature = new Uint8Array(await crypto.subtle.sign(
      { name: 'ECDSA', hash: 'SHA-256' }, privateKey, signedData,
    ))
    const verified = await crypto.subtle.verify(
      { name: 'ECDSA', hash: 'SHA-256' }, publicKey, signature, signedData,
    )

    return Response.json({ verified, signatureBytes: signature.byteLength }, { status: verified ? 200 : 500 })
  },
}

function renderReport() {
  const preparation = renderPreparation()
  const trial = report.durableObjectTrial
  const trialRows = trial.observations.map(item => `<tr><th>${item.label}</th><td>${item.value}${item.unit}</td></tr>`).join('')
  const trialSection = `<section><h2>${trial.title}</h2><p class="success">公開試験データの検証に成功</p><table><tbody>${trialRows}</tbody></table><p>${trial.scope}</p><p><small>${trial.excluded}</small></p><p>${trial.designDecision}</p><p>公式文書のCPU上限：${trial.documentedCpuLimitMs / 1000}秒（実測値ではありません）</p><details><summary>測定記録</summary><p>開始：${trial.measuredAt}<br>終了：${trial.finishedAt}<br>ソース：<code>${trial.sourceCommit}</code><br>Worker版：<code>${trial.workerVersion}</code></p><p>Durable Objectの集計期間：${trial.analyticsWindows.map(window => `${window.start} ～ ${window.end}`).join('<br>')}</p></details></section>`
  const maximum = Math.max(report.freeCpuLimitMs, ...report.series.flatMap(series => series.metrics.map(metric => metric.valueMs)))
  const sections = report.series.map(series => {
    const exceeded = series.metrics.some(metric => metric.valueMs > report.freeCpuLimitMs)
    const rows = series.metrics.map(metric => `<tr><th>${metric.label}</th><td><div class="bar" aria-label="${metric.label} ${metric.valueMs}ミリ秒"><span class="${metric.valueMs > report.freeCpuLimitMs ? 'exceeded' : ''}" style="width:${metric.valueMs / maximum * 100}%"></span><i style="left:${report.freeCpuLimitMs / maximum * 100}%"></i></div></td><td>${metric.valueMs} ms</td></tr>`).join('')
    return `<section><h2>${series.title}</h2><p class="${exceeded ? 'failure' : 'success'}">${exceeded ? '無料枠のCPU上限を超える値あり' : '今回の集計値は無料枠のCPU上限以内'}</p><p>${series.requests}回 · エラー ${series.errors}件 · サブリクエスト ${series.subrequests}回</p><table><thead><tr><th>分位点</th><th>CPU時間（破線は10ms）</th><th>実測</th></tr></thead><tbody>${rows}</tbody></table><p>${series.scope}</p><p><small>${series.excluded}</small></p><details><summary>測定記録</summary><p>開始：${series.measuredAt}<br>ソース：<code>${series.sourceCommit}</code><br>Worker版：<code>${series.workerVersion}</code></p></details></section>`
  }).join('')
  const sources = report.sources.map(source => `<a href="${source.url}">${source.label}</a>`).join(' · ')
  return `<!doctype html><html lang="ja"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>BellTeam 購読確認の無料枠試験</title>
<style>body{font:16px/1.7 system-ui,sans-serif;color:#202a35;background:#f5f7fa;margin:0;padding:32px 20px}main{max-width:820px;margin:auto;background:white;padding:32px;border-radius:16px}h1{font-size:28px;line-height:1.4}h2{font-size:20px;margin-top:32px}.result{font-size:21px}.failure{color:#b91c1c}.success{color:#166534}table{width:100%;border-collapse:collapse}th,td{text-align:left;padding:12px 8px;border-bottom:1px solid #e5e7eb}th{font-weight:500}.bar{height:18px;background:#eef2f7;position:relative;min-width:90px}.bar span{height:100%;background:#2563eb;display:block}.bar .exceeded{background:#dc2626}.bar i{position:absolute;top:-4px;bottom:-4px;border-left:2px dashed #111827}td:last-child{white-space:nowrap;text-align:right}small{color:#546171}a{color:#1d4ed8}code{overflow-wrap:anywhere}section{border-top:1px solid #d8dee6;margin-top:32px}@media(max-width:560px){main{padding:20px}body{padding:16px 12px}th,td{padding:8px 4px}}</style>
<main><h1>BellTeam 購読確認の無料枠試験</h1><p class="result">${report.conclusion}</p><p>測定したアカウントのWorkersプラン：${report.workersPlan}</p><p><small>各100回の予備測定です。実製品全体の無料運用は未確認です。</small></p>${preparation}${trialSection}<h2>入口・通常のWorkerのCPU測定</h2><p>通常のWorkerの無料枠CPU上限は${report.freeCpuLimitMs}ms。分位点はCloudflareの集計値であり、個別リクエストの最大値ではありません。</p>${sections}<p>${sources} · <a href="/report.json">数値データ</a></p></main></html>`
}

function renderPreparation() {
  const integration = setup.integration
  const distribution = integration.serverDistribution
  const tests = integration.verification.serverTests
  const builds = integration.testFlight
  const screenshots = integration.reviewReadiness.screenshotDelivery
  const publicPages = setup.worker.publicPages
  const buildPassed = build => build.processingState === 'VALID' && build.ownerGroupDistributed && build.internalBuildState === 'IN_BETA_TESTING'
  const rows = [
    ['iPhoneのTestFlight', buildPassed(builds.IOS), `ビルド${builds.IOS.build}・内部テスト開始`],
    ['MacのTestFlight', buildPassed(builds.MAC_OS), `ビルド${builds.MAC_OS.build}・内部テスト開始`],
    ['サポートとプライバシー方針', publicPages.pagesVerified === 2 && integration.reviewReadiness.publicLinksRegisteredForBothPlatforms, `<a href="${product.supportUrl}">サポート</a>・<a href="${product.privacyPolicyUrl}">プライバシー方針</a>を公開・両アプリのストア情報へ登録`],
    ['iPhoneのストア画像', screenshots.IOS.complete, `${screenshots.IOS.count}枚・Apple側の処理完了`],
    ['Macのストア画像', screenshots.MAC_OS.complete, screenshots.MAC_OS.complete ? `${screenshots.MAC_OS.count}枚・Apple側の処理完了` : `撮影用ビルドは成功・Jevの画面読み取りが${screenshots.MAC_OS.error}で停止`],
    ['Dockerイメージの一般公開', distribution.imagePublished && distribution.anonymousPull, distribution.imagePublished && distribution.anonymousPull ? '公開レジストリから未認証で取得を確認' : distribution.imageRegistered ? '登録と配布用設定の検査は成功・GitHubでPublicへ変更待ち' : '未登録'],
    ['イメージからの新規設置', distribution.registryImageInstallVerified, distribution.registryImageInstallVerified ? '公開レジストリから取得しLinuxで正常起動を確認' : '公開レジストリからの未認証取得・Linux設置は未確認'],
    ['サーバーの自動試験', tests.passed === tests.total, `${tests.passed}／${tests.total}件成功`],
    ['配布用コードのLinux試験', distribution.linuxSmoke === 'passed', '以前の配布用コードでビルド・保存先の初期化・正常起動を確認'],
    ['一般配布版の購読制限', distribution.publicDeveloperModeRejected && distribution.unpaidAIUseRejected, '開発者免除の設定を拒否・未購入のAI利用を拒否'],
    ['配布内容の照合', distribution.portableArchiveVerified && distribution.runtimePayloadMatchesLinuxTest, `内部の梱包試験でLinux確認済みの実装と${distribution.payloadMatchingFiles}ファイル一致`],
    ['購読試験用の接続環境', integration.reviewEnvironment.serverStarted && integration.reviewEnvironment.realAIConfigured, integration.reviewEnvironment.serverStarted && integration.reviewEnvironment.realAIConfigured ? '専用サーバーの起動とAI設定を確認' : 'Cloudflare Access設定の権限が不足・専用環境は未起動'],
    ['Appleの実購入・復元', integration.realApplePurchaseVerified, integration.realApplePurchaseVerified ? 'Sandboxの実取引を確認' : 'Sandboxの実取引は未確認'],
    ['App Store審査への提出', integration.reviewReadiness.reviewSubmitted, integration.reviewReadiness.reviewSubmitted ? 'Appleへ審査を提出' : '年齢区分・Macと購読画面の画像・審査用接続環境と連絡先が未完了'],
  ].map(([label, passed, detail]) => `<tr><th>${label}</th><td class="${passed ? 'success' : 'failure'}">${passed ? '確認済み' : '未完了'}</td><td>${detail}</td></tr>`).join('')
  return `<section><h2>公開準備の確認</h2><p>配布・Linux導入・購読の検証結果です。</p><style>.preparation td:last-child{white-space:normal;text-align:left}.preparation td:nth-child(2){white-space:nowrap}.preparation th{width:28%}</style><table class="preparation"><tbody>${rows}</tbody></table><p><small>Linuxの起動確認にはAIログインと実購入を含めていません。</small></p></section>`
}
