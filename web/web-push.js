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

export function createWebPushSettings(root, api, browser=globalThis) {
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
  function render() {
    if (!active) return
    const environment=pushEnvironment(browser)
    node('environment').textContent=environment.supported ? 'Web通知に対応しています。' : environment.reason
    node('permission').textContent=({default:'まだ許可していません',granted:'許可済み',denied:'ブラウザー設定で拒否されています',unknown:'未確認'})[environment.permission]
    node('browser').textContent=!browserKnown ? '購読を確認できません' : subscription ? 'このブラウザーに購読があります' : 'このブラウザーに購読はありません'
    node('server').textContent=!serverKnown ? serverFailure || '通知サーバーは未接続・未確認です' : status.error ? '通知サーバーの設定でエラーが発生しています' : !status.enabled ? 'Web通知は無効です' : !status.configured ? '通知サーバーの準備が完了していません' : '通知サーバーの準備ができています'
    node('registration').textContent=registered === true ? 'サーバーに登録されています（配信結果は未確認）' : registered === false ? 'この購読はサーバーに登録されていません' : browserKnown && !subscription && !cleanup ? '照会対象の購読はありません' : '登録は未確認です'
    let hint=message
    if (!hint && environment.permission === 'denied') hint='ブラウザーまたは端末の設定で通知を許可してから、状態を更新してください。'
    if (!hint && keyMismatch()) hint='公開鍵が変わっているか、購読の鍵を確認できません。解除してから明示的に登録し直してください。'
    if (!hint && serverKnown && !status.enabled) hint='追加機能でWeb通知を有効にしてから、このブラウザーを登録してください。'
    node('notice').textContent=busy ? '通知の設定を処理しています…閉じても結果を確認できます。' : hint
    const expired=subscription?.expirationTime != null && subscription.expirationTime <= Date.now()
    if (expired && !busy) node('notice').textContent='購読の期限が切れています。解除してから登録し直してください。'
    enable.disabled=busy || !environment.supported || environment.permission === 'denied' || !serverKnown || !status.enabled || !status.configured || Boolean(status.error) || !browserKnown || Boolean(cleanup) || keyMismatch() || expired || registered === true
    enable.textContent=!registration ? '通知を準備する' : subscription ? 'サーバーへ登録する' : '通知を許可・登録する'
    remove.disabled=busy || !cleanup && !subscription
    remove.textContent=cleanup ? '未完了の解除を再試行' : 'このブラウザーの登録を解除'
    reload.disabled=busy
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
        message='通知の準備ができました。続けて「通知を許可・登録する」を押してください。'
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
        registered=true;message='サーバーへの登録を確認しました。通知の配信・端末表示はまだ確認していません。'
      } catch (error) {
        try { registered=await lookup(next.endpoint) } catch { registered=null }
        message=registered === true ? '応答は途切れましたが、サーバーへの登録を照会で確認しました。'
          : error.status === 403 ? 'この接続元では登録できません。認証と公開URLを確認してください。ブラウザーの購読は残っています。'
          : 'サーバーへの登録を確認できませんでした。ブラウザーの購読を保持しています。再登録は自動で行いません。'
      }
    } catch { message='ブラウザーの通知設定を完了できませんでした。状態を更新して確認してください。' }
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
      if (attempt.serverDone && attempt.browserDone) { cleanup=null;subscription=null;registered=false;message='ブラウザーとサーバーの登録解除を確認しました。通知の許可自体は端末の設定に残ることがあります。' }
      else message=`${attempt.serverDone ? 'サーバー側は解除済み' : 'サーバー側の解除は未確認'}。${attempt.browserDone ? 'ブラウザー側は解除済み' : 'ブラウザー側の解除は未確認'}。未完了の部分だけ再試行できます。`
    } finally { busy=false;render();if(active)await refresh() }
  }
  enable.addEventListener('click',register);remove.addEventListener('click',unregister)
  reload.addEventListener('click',()=>{message='';void refresh()})
  return {async open(){active=true;render();await refresh()},close(){active=false;read++},refresh}
}
