export const conversationMotionKey = 'bellteam-conversation-motion.v1'
export function readConversationMotion() {
  try { return globalThis.window?.localStorage?.getItem(conversationMotionKey) === 'fade' ? 'fade' : 'rise' } catch { return 'rise' }
}
export function animateConversation(timeline) {
  if (globalThis.matchMedia?.('(prefers-reduced-motion: reduce)').matches) return
  const rise = readConversationMotion() === 'rise'
  timeline.animate?.([{ opacity:0, transform:rise ? 'translateY(12px)' : 'none' }, { opacity:1, transform:'none' }], { duration:180, easing:'ease-out' })
}
