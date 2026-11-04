const exact=(value,keys)=>value && typeof value === 'object' && Object.keys(value).length === keys.length && keys.every(key=>Object.hasOwn(value,key))
const bytes=value=>new TextEncoder().encode(value).length
export const notificationId=value=>typeof value === 'string' && value.length > 0 && bytes(value) <= 200 && !/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/u.test(value)
export function notificationRoute(value) {
  if (exact(value,['kind']) && value.kind === 'update') return value
  if (!exact(value,['kind','messageId','requestId','botId','roomId']) || !notificationId(value.messageId) || !notificationId(value.botId) || value.roomId !== null && !notificationId(value.roomId)) return null
  if (value.kind === 'reply' ? value.requestId !== null : !['secret_request','owner_question'].includes(value.kind) || value.requestId !== value.messageId) return null
  if (value.kind === 'owner_question' && value.roomId !== null) return null
  return value
}
export function parseNotificationPayload(text) {
  if (typeof text !== 'string' || bytes(text) > 3072) return null
  try {
    const value=JSON.parse(text)
    if (value?.kind === 'update') {
      if (!exact(value,['schema','kind','messageId','title','body']) || value.schema !== 'bellteam.web-push.v1'
        || !/^[a-f0-9]{64}$/.test(value.messageId) || value.title !== 'BellTeam' || value.body !== '更新があります。Updateで確認してください。') return null
      return {value,route:{kind:'update'}}
    }
    if (!exact(value,['schema','kind','messageId','requestId','botId','roomId','sender','roomName','title','body']) || value.schema !== 'bellteam.web-push.v1'
      || !exact(value.sender,['id','name']) || value.sender.id !== value.botId || typeof value.sender.name !== 'string' || typeof value.title !== 'string' || typeof value.body !== 'string') return null
    const route=notificationRoute({kind:value.kind,messageId:value.messageId,requestId:value.requestId,botId:value.botId,roomId:value.roomId})
    if (!route || (value.kind === 'reply' && value.roomId !== null ? typeof value.roomName !== 'string' : value.roomName !== null)) return null
    const expected=notificationPresentation({value,route})
    const title=value.kind === 'reply' && value.roomId !== null ? `${value.sender.name} · ${value.roomName}` : value.sender.name
    if (value.title !== title || value.body !== expected.body) return null
    return {value,route}
  } catch { return null }
}
export function notificationPresentation(parsed) {
  if (!parsed) return {title:'BellTeam',body:'新しいお知らせがあります。',route:null}
  const {value,route}=parsed
  if (route.kind === 'update') return {title:value.title,body:value.body,route}
  const sender=value.sender.name || 'メンバー'
  const title=route.kind === 'reply' && route.roomId ? `${sender} · ${value.roomName}` : sender
  return {title:[...title].slice(0,100).join(''),body:route.kind === 'secret_request' ? '秘密情報の入力が必要です。' : route.kind === 'owner_question' ? '選んでほしいことがあります。' : route.roomId ? 'ルームに新しいメッセージが届きました。' : '返信が届きました。',route}
}
export function notificationURL(route,origin) {
  const url=new URL('/',origin)
  if (notificationRoute(route)) url.searchParams.set('notification',JSON.stringify(route))
  return url.href
}
