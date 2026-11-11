import { pathToFileURL } from 'node:url'
import { text } from 'node:stream/consumers'
import { webGatewayInstallPlan } from './web-gateway-install-plan.mjs'
export const latticeInstallPlan = (normal, current) => webGatewayInstallPlan(normal, current, 'lattice')
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    if (process.argv.length !== 2) throw new Error()
    const [encodedNormal, current] = JSON.parse(await text(process.stdin))
    const normal = JSON.parse(JSON.stringify(encodedNormal).replaceAll('$$', '$'))
    console.log(JSON.stringify(latticeInstallPlan(normal, current), (_key, value) => typeof value === 'string' ? value.replaceAll('$', () => '$$') : value))
  } catch { console.error('LATTICE_INSTALL_MODEL_INVALID'); process.exitCode = 1 }
}
