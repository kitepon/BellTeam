import { notificationRoute } from './notification-payload.js?v=__ASSET_VERSION__'

const storageKey='bellteam-notification-route.v1'
export function createNotificationNavigation({onRoute,onNotice,onRoot=()=>{},browser=globalThis}) {
  let pending=null,ready=false,busy=false
  const store=()=>{
    try {if(pending)browser.sessionStorage.setItem(storageKey,JSON.stringify(pending));else browser.sessionStorage.removeItem(storageKey)}catch{}
    try {const url=new URL(browser.location.href);if(pending)url.searchParams.set('notification',JSON.stringify(pending));else url.searchParams.delete('notification');browser.history.replaceState(null,'',url.href)}catch{}
  }
  try { pending=notificationRoute(JSON.parse(browser.sessionStorage?.getItem(storageKey) ?? 'null')) } catch {}
  try {
    const url=new URL(browser.location.href)
    if (url.searchParams.has('notification')) {
      try { pending=url.searchParams.getAll('notification').length === 1 ? notificationRoute(JSON.parse(url.searchParams.get('notification'))) : null } catch { pending=null }
      store()
      if (!pending) {onRoot();onNotice('通知の対象を確認できません。一覧から確認してください。')}
    }
  } catch {}
  async function apply() {
    if (!ready || busy || !pending) return
    busy=true
    const route=pending
    try {
      await onRoute(route)
      if (pending === route) {
        pending=null;store();onNotice('')
        const url=new URL(browser.location.href)
        if (url.searchParams.has('notification')) {url.searchParams.delete('notification');browser.history.replaceState(null,'',url.href)}
      }
    } catch (error) { if(pending === route)onNotice(error.message === 'EDITOR_OPEN' ? '入力中の画面があります。保存またはキャンセルして閉じてから、通知の対象を再確認してください。' : '通知の対象を開けませんでした。認証・接続と対象を確認して、再確認してください。') }
    finally {busy=false;if(pending && pending !== route)void apply()}
  }
  const receive=event=>{
    if (event.origin !== browser.location.origin || event.data?.type !== 'bellteam-notification') return
    const route=notificationRoute(event.data.route)
    if (!route) {pending=null;store();onRoot();onNotice('通知を確認しました。対象の案内を取得できないため、一覧から確認してください。');return }
    pending=route;store();void apply()
  }
  browser.navigator?.serviceWorker?.addEventListener('message',receive)
  return {async ready(){ready=true;await apply()},retry:apply,close(){ready=false;browser.navigator?.serviceWorker?.removeEventListener('message',receive)}}
}
