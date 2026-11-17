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

// 法務ページ（サポート・プライバシー・規約・特商法）の正本はkitepon.dev。ここには本文を持たず、古いURLをそちらへ恒久転送する。
export function publicPageResponse(request) {
  const path = new URL(request.url).pathname
  if (!['/', '/support', '/privacy'].includes(path) && !serverFiles.has(path)) return null
  if (!['GET', 'HEAD'].includes(request.method)) return new Response('GETを使ってください。', { status: 405, headers: { Allow: 'GET, HEAD' } })
  if (serverFiles.has(path)) return new Response(request.method === 'HEAD' ? null : serverFiles.get(path), {
    headers: { 'Content-Type': 'text/plain; charset=utf-8', 'Content-Disposition': `attachment; filename="${path.split('/').at(-1)}"` },
  })
  return Response.redirect(path === '/privacy' ? product.privacyPolicyUrl : product.supportUrl, path === '/' ? 302 : 301)
}
