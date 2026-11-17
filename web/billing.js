// 「利用と購読」の購入の入口（Stripe）。購入画面はサーバーが作り、ここは開いて結果を読むだけ。
// 文言と並びはWindows・Linuxと同じ（a335/a336/a337）。AppleアプリのApp内課金には触れない。
const KEY = 'bellteam.stripe-session'
const sessionPattern = /^cs_[A-Za-z0-9_]{1,200}$/u
const json = body => ({ method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
const valid = value => value && typeof value === 'object' && typeof value.entitled === 'boolean' && typeof value.accessMode === 'string'

export function createBillingSettings(root, api, browser = globalThis, { onChange = () => {} } = {}) {
  const node = key => root.querySelector(`[data-billing-${key}]`)
  const start = node('start'), caption = node('caption'), confirm = node('confirm'), recheck = node('recheck'), state = node('state'), notice = node('notice')
  let subscription = null, loaded = false, session = null, busy = false, hidden = false, message = '', generation = 0
  // shortcut: 保存先は使えない時もある。使えなければ、この画面の間だけ覚える。
  const remember = value => { session = value; try { value ? browser.localStorage.setItem(KEY, value) : browser.localStorage.removeItem(KEY) } catch {} }
  const recall = () => { try { const saved = browser.localStorage.getItem(KEY); if (sessionPattern.test(saved)) session = saved } catch {} }

  function lines() {
    if (!loaded) return []
    if (!subscription) return ['購読の状態を確認できませんでした。再確認してください。']
    if (subscription.accessMode === 'developer') return ['このサーバーでは購読の購入は不要です。']
    if (!subscription.entitled) return []
    const until = new Date(subscription.validUntil)
    return [`有効期限：${Number.isNaN(+until) ? subscription.validUntil : until.toLocaleString('ja-JP', { dateStyle: 'medium', timeStyle: 'short' })}`,
      ...subscription.isTrial ? ['無料期間中です。'] : [], ...subscription.autoRenewing === false ? ['自動更新は停止しています。有効期限までは利用できます。'] : []]
  }
  function render() {
    const buyable = valid(subscription) && !subscription.entitled && subscription.accessMode !== 'developer'
    start.hidden = caption.hidden = !buyable || hidden
    confirm.hidden = !buyable || !session
    start.disabled = confirm.disabled = recheck.disabled = busy
    state.textContent = lines().join(' ')
    notice.textContent = message
    onChange({ line: subscription?.entitled ? lines()[0] : 'Web版は無料' })
  }
  const failure = (error, fallback) => typeof error?.message === 'string' && error.status ? error.message : fallback

  async function read(path, options, fallback) {
    const token = ++generation
    try {
      const result = await api(path, options)
      if (!valid(result?.subscription)) throw Error('INVALID_SUBSCRIPTION')
      if (token === generation) { subscription = result.subscription; return true }
    } catch (error) { if (token === generation) { if (!subscription || path === '/api/subscription') subscription = null; message = failure(error, fallback) } }
    return false
  }
  const guarded = async run => { if (busy) return; busy = true; message = ''; render(); try { await run() } finally { busy = false; render() } }

  async function verify() {
    if (await read('/api/subscription/stripe/verify', json({ stripeSessionId: session }), '購入を確認できませんでした。')) {
      if (subscription.entitled) remember(null)
      message = subscription.entitled ? 'この購読が有効になりました。' : '購入情報を確認しました。現在の購読は有効ではありません。'
    }
  }

  const view = {
    // 設定の「利用と購読」を開いた時。保存した購入IDがあれば、戻ってきた後の状態を読む。
    open: () => guarded(async () => {
      recall()
      const returned = new URLSearchParams(browser.location?.search ?? '').get('session_id')
      if (sessionPattern.test(returned ?? '')) { remember(returned); browser.history?.replaceState?.(null, '', browser.location.pathname) }
      await read('/api/subscription', undefined, '')
      loaded = true
      if (subscription && !subscription.entitled && session && returned) await verify()
    }),
    // 購入画面は、押された時に一回だけ作る（呼ぶたびにStripeのsessionができる）。
    start: () => guarded(async () => {
      // 押した直後に空の窓を開けておく。非同期の後に開くと、ブラウザーが止めることがある。
      const tab = browser.open?.('', '_blank') ?? null
      try {
        const result = await api('/api/subscription/stripe/checkout', json({}))
        const url = new URL(result?.url)
        if (url.protocol !== 'https:' || !sessionPattern.test(result.sessionId)) throw Error('INVALID_CHECKOUT')
        remember(result.sessionId)
        if (tab) { tab.opener = null; tab.location.href = url.href } else browser.location.assign(url.href)
        message = 'Stripeの購入画面を開きました。購入したら「購入を確認」を押してください。'
      } catch (error) {
        tab?.close()
        // Stripeが未設定（503）か開発者用サーバー（409）の時は、入口ごと隠す。通信の失敗では隠さない。
        if (['SUBSCRIPTION_NOT_CONFIGURED', 'SUBSCRIPTION_NOT_REQUIRED'].includes(error?.code)) hidden = true
        else message = failure(error, '購入画面を開けませんでした。')
      }
    }),
    confirm: () => guarded(() => session ? verify() : Promise.resolve()),
    recheck: () => guarded(async () => { if (await read('/api/subscription/refresh', json({}), '購読の状態を確認できませんでした。再確認してください。')) message = '' }),
    render,
  }
  start.addEventListener('click', () => void view.start())
  confirm.addEventListener('click', () => void view.confirm())
  recheck.addEventListener('click', () => void view.recheck())
  render()
  return view
}
