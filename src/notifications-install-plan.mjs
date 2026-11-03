import { pathToFileURL } from 'node:url'
import { text } from 'node:stream/consumers'
import { webGatewayInstallPlan } from './web-gateway-install-plan.mjs'
export const notificationsInstallPlan = (normal, current) => webGatewayInstallPlan(normal, current, 'notifications')
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    if (process.argv.length !== 2) throw new Error()
    const [encodedNormal, current] = JSON.parse(await text(process.stdin))
    const normal = JSON.parse(JSON.stringify(encodedNormal).replaceAll('$$', '$'))
    console.log(JSON.stringify(notificationsInstallPlan(normal, current), (_key, value) => typeof value === 'string' ? value.replaceAll('$', () => '$$') : value))
  } catch { console.error('NOTIFICATIONS_INSTALL_MODEL_INVALID'); process.exitCode = 1 }
}
