import { parseNotificationPayload, notificationPresentation, notificationRoute, notificationURL } from './notification-payload.js?v=__ASSET_VERSION__'

export function installNotificationWorker(scope) {
  scope.addEventListener('install',event=>event.waitUntil(scope.skipWaiting()))
  scope.addEventListener('activate',event=>event.waitUntil(scope.clients.claim()))
  scope.addEventListener('push',event=>{
    let parsed=null
    try { parsed=parseNotificationPayload(event.data?.text()) } catch {}
    const notice=notificationPresentation(parsed)
    event.waitUntil(scope.registration.showNotification(notice.title,{body:notice.body,icon:'/icons/icon-192.png',badge:'/icons/icon-192.png',data:notice.route,tag:notice.route?.kind === 'update' ? parsed.value.messageId : notice.route?.messageId}))
  })
  scope.addEventListener('notificationclick',event=>{
    event.notification.close()
    const route=notificationRoute(event.notification.data)
    event.waitUntil((async()=>{
      const windows=await scope.clients.matchAll({type:'window',includeUncontrolled:true})
      const client=windows.find(item=>{try {const url=new URL(item.url);return url.origin === scope.location.origin && ['/', '/index.html'].includes(url.pathname)}catch{return false}})
      if (client) { await client.focus();client.postMessage({type:'bellteam-notification',route}) }
      else await scope.clients.openWindow(notificationURL(route,scope.location.origin))
    })())
  })
}
