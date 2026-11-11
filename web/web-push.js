const exact = (value, keys) => value && typeof value === 'object' && Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value,key))
export function decodePushKey(value) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-]{87}$/u.test(value)) return null
  try { const bytes = Uint8Array.from(atob(value.replace(/-/gu,'+').replace(/_/gu,'/')+'='), c=>c.charCodeAt(0)); return bytes.length === 65 && bytes[0] === 4 && encodeKey(bytes) === value ? bytes : null } catch { return null }
}
const encodeKey = value => value ? btoa(String.fromCharCode(...new Uint8Array(value))).replace(/\+/gu,'-').replace(/\//gu,'_').replace(/=+$/u,'') : null
export function validPushStatus(value) {
  return exact(value,['enabled','configured','publicKey','error']) && typeof value.enabled === 'boolean' && typeof value.configured === 'boolean'
    && (value.publicKey === null || Boolean(decodePushKey(value.publicKey))) && (!value.configured || Boolean(value.publicKey))
    && (value.error === null || exact(value.error,['code','message']) && typeof value.error.code === 'string' && /^[A-Z0-9_]{1,100}$/u.test(value.error.code) && typeof value.error.message === 'string')
}
export function pushEnvironment(browser) {
  const nav=browser.navigator
  const apple=/iPhone|iPad|iPod/u.test(nav?.userAgent ?? '') || nav?.platform === 'MacIntel' && nav.maxTouchPoints > 1
  const standalone=browser.matchMedia?.('(display-mode: standalone)').matches || nav?.standalone === true
  const reason=!browser.isSecureContext ? '安全な接続（HTTPS）が必要です。'
    : apple && !standalone ? 'iPhone・iPadではホーム画面に追加したBellTeamから設定してください。'
    : !nav?.serviceWorker || !browser.PushManager || !browser.Notification ? 'このブラウザーはWeb通知に対応していません。' : ''
  return {supported:!reason,reason,permission:['default','granted','denied'].includes(browser.Notification?.permission) ? browser.Notification.permission : 'unknown'}
}

export function createWebPushSettings(root, api, browser=globalThis, { onChange=()=>{} }={}) {
  const node=key=>root.querySelector(`[data-web-push-${key}]`)
  const enable=node('enable'),remove=node('remove'),reload=node('refresh')
  let active=false,busy=false,read=0,status=null,serverKnown=false,serverFailure='',subscription=null,registration=null,browserKnown=false,registered=null,cleanup=null,message=''
  const post=(path,body)=>request(path,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)})
  async function request(path,options={}) {
    const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),20000)
    timer.unref?.()
    try { return await api(path,{...options,signal:controller.signal}) } finally { clearTimeout(timer) }
  }
  const lookup=async endpoint=>{
    const result=await post('/api/web-push/status',{endpoint})
    if (!exact(result,['registered']) || typeof result.registered !== 'boolean') throw Error('INVALID_STATUS')
    return result.registered
  }
  const keyMismatch=()=>Boolean(subscription && status?.publicKey && encodeKey(subscription.options?.applicationServerKey) !== status.publicKey)
  // 状態をひとつに決めて、札・一文・その状態のボタンだけを出す（user-paths.md 4.8）。
  function state(environment) {
    const expired=subscription?.expirationTime != null && subscription.expirationTime <= Date.now()
    if (!environment.supported) return { key:'unsupported', badge:'使えません', tone:'muted', line:environment.reason }
    if (cleanup) return { key:'cleanup', badge:'解除の途中', tone:'attention', line:'解除が終わっていません。「解除をもう一度」を押してください。' }
    if (!serverKnown) return { key:'unknown', badge:'確認できません', tone:'attention', line:serverFailure || '通知の設定を読めませんでした。「確かめ直す」を押してください。' }
    if (status.error) return { key:'serverError', badge:'エラー', tone:'attention', line:'通知の送り先の設定でエラーが起きています。設定を確かめてください。' }
    if (!status.enabled || !status.configured) return { key:'serverOff', badge:'未設定', tone:'muted', line:'ブラウザーへの通知を送る設定が、まだできていません。' }
    if (environment.permission === 'denied') return { key:'denied', badge:'ブロック中', tone:'attention', line:'ブラウザーが通知をブロックしています。ブラウザーの設定で許可してから「確かめ直す」を押してください。' }
    if (keyMismatch()) return { key:'mismatch', badge:'要対応', tone:'attention', line:'通知の鍵が変わりました。いったん受け取るのをやめて、もう一度登録してください。' }
    if (expired) return { key:'expired', badge:'要対応', tone:'attention', line:'通知の登録の期限が切れました。いったん受け取るのをやめて、もう一度登録してください。' }
    if (registered === true) return { key:'on', badge:'受け取ります', tone:'ok', line:'このブラウザーに通知が届きます。' }
    if (!browserKnown) return { key:'unknown', badge:'確認できません', tone:'attention', line:'このブラウザーの通知の状態を読めませんでした。「確かめ直す」を押してください。' }
    return { key:'off', badge:'未登録', tone:'', line: registration && !subscription ? '準備ができました。「通知を許可する」を押すと、ブラウザーが許可を求めます。' : 'このブラウザーは、まだ通知を受け取りません。' }
  }
  function render() {
    if (!active) return
    const environment=pushEnvironment(browser), current=state(environment)
    const badge=node('state'), line=node('summary')
    if (badge) { badge.textContent=busy ? '処理中' : current.badge; badge.className=`settings-badge tone-${busy ? 'info' : current.tone}` }
    if (line) line.textContent=current.line
    node('notice').textContent=busy ? '通知の設定を処理しています…閉じても結果を確認できます。' : message
    const show=(button,visible)=>{ button.hidden=!visible }
    show(enable,['off'].includes(current.key))
    enable.disabled=busy || current.key !== 'off'
    enable.textContent=!registration ? 'このブラウザーで受け取る' : subscription ? 'サーバーへ登録する' : '通知を許可する'
    show(remove,['on','mismatch','expired','cleanup'].includes(current.key) || Boolean(subscription && current.key === 'off'))
    remove.disabled=busy || !cleanup && !subscription
    remove.textContent=cleanup ? '解除をもう一度' : 'このブラウザーでは受け取らない'
    show(reload,['unknown','denied','serverError'].includes(current.key))
    reload.disabled=busy
    const feature=node('feature')
    if (feature) feature.hidden=!['serverOff','serverError'].includes(current.key)
    onChange({ line: current.key === 'on' ? 'このブラウザーに届きます' : current.key === 'off' ? 'このブラウザーは未登録' : current.key === 'serverOff' ? '通知の送り先が未設定' : current.line, badge: current.badge, tone: current.tone === 'ok' ? 'ok' : current.tone === 'attention' ? 'attention' : '' })
  }
  async function refresh() {
    if (!active || busy) return
    const version=++read
    const environment=pushEnvironment(browser)
    let nextStatus=null,nextSub=null,nextRegistration=null,nextKnown=false,nextRegistered=null,nextFailure=''
    try { const value=await request('/api/web-push/status');if(!validPushStatus(value))throw Error('INVALID_STATUS');nextStatus=value } catch (error) { if(error.status === 401 || error.status === 403)nextFailure='通知設定の確認にはオーナーの認証が必要です。' }
    if (environment.supported) {
      try {
        const found=await browser.navigator.serviceWorker.getRegistration(new URL('/',browser.location.origin).href)
        const worker=found?.active ?? found?.waiting ?? found?.installing
        if (found && (found.scope !== browser.location.origin+'/' || new URL(worker?.scriptURL ?? '').pathname !== '/sw.js' || new URL(worker.scriptURL).origin !== browser.location.origin)) throw Error('OTHER_WORKER')
        nextRegistration=found
        nextSub=found ? await found.pushManager.getSubscription() : null;nextKnown=true
      } catch {}
    }
    if (nextStatus && (cleanup?.endpoint || nextSub?.endpoint)) { try { nextRegistered=await lookup(cleanup?.endpoint || nextSub.endpoint) } catch {} }
    if (!active || busy || version !== read) return
    status=nextStatus;serverKnown=Boolean(nextStatus);serverFailure=nextFailure;subscription=nextSub;registration=nextRegistration;browserKnown=nextKnown;registered=nextRegistered
    render()
  }
  async function register() {
    if (!active || enable.disabled || busy) return
    busy=true;read++;message='';render()
    try {
      if (!registration) {
        registration=await browser.navigator.serviceWorker.register('/sw.js',{scope:'/',type:'module',updateViaCache:'none'})
        await browser.navigator.serviceWorker.ready
        message=''
        return
      }
      // Preparation and consent use separate clicks so network waits cannot consume user activation.
      const permission=browser.Notification.permission === 'default' ? await browser.Notification.requestPermission() : browser.Notification.permission
      if (permission !== 'granted') { message='通知は許可されませんでした。ブラウザー設定から変更できます。';return }
      let next=subscription
      if (!next) next=await registration.pushManager.subscribe({userVisibleOnly:true,applicationServerKey:decodePushKey(status.publicKey)})
      subscription=next;browserKnown=true
      if (encodeKey(next.options?.applicationServerKey) !== status.publicKey) { message='購読の鍵が一致しません。解除してから登録し直してください。';return }
      const value=next.toJSON()
      const body={subscription:{endpoint:next.endpoint,expirationTime:next.expirationTime ?? null,keys:{p256dh:value.keys?.p256dh,auth:value.keys?.auth}},applicationServerKey:status.publicKey}
      try {
        const result=await post('/api/web-push/subscriptions',body)
        if (!exact(result,['registered']) || result.registered !== true) throw Error('INVALID_REGISTRATION')
        registered=true;message='登録しました。このブラウザーに通知が届きます。'
      } catch (error) {
        try { registered=await lookup(next.endpoint) } catch { registered=null }
        message=registered === true ? '応答は途切れましたが、サーバーへの登録を照会で確認しました。'
          : error.status === 403 ? 'この接続元では登録できません。認証と公開URLを確認してください。ブラウザーの購読は残っています。'
          : 'サーバーへの登録を確認できませんでした。ブラウザーの購読を保持しています。再登録は自動で行いません。'
      }
    } catch { message='ブラウザーの通知の設定を終えられませんでした。「確かめ直す」を押してください。' }
    finally { busy=false;render();if(active)await refresh() }
  }
  async function unregister() {
    if (!active || remove.disabled || busy) return
    cleanup ??= {endpoint:subscription.endpoint,subscription,serverDone:false,browserDone:false}
    const attempt=cleanup
    busy=true;read++;message='';render()
    try {
      if (!attempt.serverDone) {
        try { const result=await post('/api/web-push/unregister',{endpoint:attempt.endpoint});if(!exact(result,['registered']) || result.registered !== false)throw Error('INVALID_REMOVAL');attempt.serverDone=true }
        catch { try { attempt.serverDone=await lookup(attempt.endpoint) === false } catch {} }
      }
      if (!attempt.browserDone) {
        try {
          attempt.browserDone=await attempt.subscription.unsubscribe() === true
          if (!attempt.browserDone) {
            const found=await browser.navigator.serviceWorker.getRegistration(new URL('/',browser.location.origin).href)
            const remaining=await found?.pushManager.getSubscription()
            attempt.browserDone=!remaining || remaining.endpoint !== attempt.endpoint
          }
        } catch {}
      }
      if (attempt.serverDone && attempt.browserDone) { cleanup=null;subscription=null;registered=false;message='このブラウザーでは、もう通知を受け取りません。' }
      else message=`${attempt.serverDone ? 'サーバー側は解除済み' : 'サーバー側の解除は未確認'}。${attempt.browserDone ? 'ブラウザー側は解除済み' : 'ブラウザー側の解除は未確認'}。未完了の部分だけ再試行できます。`
    } finally { busy=false;render();if(active)await refresh() }
  }
  enable.addEventListener('click',register);remove.addEventListener('click',unregister)
  reload.addEventListener('click',()=>{message='';void refresh()})
  return {async open(){active=true;render();await refresh()},close(){active=false;read++},refresh}
}
