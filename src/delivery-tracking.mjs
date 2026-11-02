// 保存・公開の境界では既知の根拠だけを作り直し、任意fieldを渡さない。
export function deliveryTracking(delivery, value) {
  if (delivery !== 'failed' || value?.schema !== 'bellteam.delivery-tracking.v1'
    || value.admission !== 'accepted' || value.completion !== 'unknown') return null
  return { schema: 'bellteam.delivery-tracking.v1', admission: 'accepted', completion: 'unknown' }
}
