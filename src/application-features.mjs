import { dirname } from 'node:path'
import { mkdir, writeFile } from 'node:fs/promises'
import { createCallBridgeServer, listenCallBridge } from './call-bridge-server.mjs'
import { createDiagnosticsAdminServer } from './diagnostics.mjs'
import { cloudflareAccessAuthorizer } from './cloudflare-access.mjs'
import { isLocalHostname } from './server-address.mjs'
import { writeHarnessConfig } from './harness-config.mjs'

// Feature settings own their listeners/configuration. They do not own Bot delivery state.
export function createApplicationFeatures({ services, aiterm, home, callBridgeHeaders, environment = process.env, notify }) {
  const { bots, messenger, settings, diagnostics, notifications, transport } = services
  let cloudflareAuthorize = null
  const configureCloudflare = config => {
    cloudflareAuthorize = config.enabled ? cloudflareAccessAuthorizer(config) : null
  }
  configureCloudflare(settings.configuration('cloudflare'))
  const authMode = request => {
    if (!cloudflareAuthorize) return 'local'
    const host = new URL(`http://${request.headers.host}`).hostname
    return isLocalHostname(host) ? 'local' : 'cloudflare'
  }
  let adminServer = null
  const callBridgeSocket = environment.BELLTEAM_CALL_BRIDGE_SOCKET
  let closeCallBridge = null
  const closeServer = server => new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()))
  const configureDiagnostics = async config => {
    if (adminServer) { await closeServer(adminServer); adminServer = null }
    if (!config.enabled) return
    const next = createDiagnosticsAdminServer({ diagnostics, key: config.key })
    await new Promise((resolve, reject) => {
      next.once('error', reject)
      next.listen(Number(environment.BELLTEAM_ADMIN_PORT ?? 4182), '0.0.0.0', resolve)
    })
    adminServer = next
  }
  const configureCalls = async config => {
    await closeCallBridge?.()
    closeCallBridge = null
    if (config.enabled) {
      await mkdir(dirname(callBridgeHeaders), { recursive: true })
      await writeFile(callBridgeHeaders, `Authorization: Bearer ${config.token}\n`, { mode: 0o600 })
      if (callBridgeSocket) closeCallBridge = await listenCallBridge(createCallBridgeServer({ bots, messenger }), callBridgeSocket)
    }
    await writeHarnessConfig(bots, home, { aiterm: async () => aiterm, callBridge: config })
  }
  const initialize = async () => {
    for (const [id, apply] of [['diagnostics', configureDiagnostics], ['callBridge', configureCalls], ['notifications', value => notifications.configure(value)]]) {
      try { await apply(settings.configuration(id)) }
      catch (error) {
        settings.setError(id, error)
        process.stderr.write(`BellTeam: ${id}の設定を反映できませんでした\n`)
        await diagnostics.record({ code: 'SERVER_FEATURE_CONFIGURATION_FAILED', module: 'server', diagnostic_log: id })
      }
    }
    settings.onChange = async (id, config) => {
      settings.setError(id, null)
      try {
        if (id === 'cloudflare') configureCloudflare(config)
        if (id === 'diagnostics') await configureDiagnostics(config)
        if (id === 'callBridge') {
          await configureCalls(config)
          // CLIは起動時にMCP登録を読む。現在のターンを終えたら閉じ、次の配送で新しい登録を読む。
          for (const bot of bots.values()) {
            if (!await transport.isRunning(bot)) continue
            transport.stopForConfiguration(bot).catch(async error => {
              process.stderr.write(`BellTeam: 通話設定をメンバーへ反映できませんでした (${bot.id})\n`)
              settings.setError(id, error)
              notify({ type: 'settings', featureId: id })
              await diagnostics.record({ code: 'SERVER_CALL_CONFIGURATION_FAILED', module: 'server', diagnostic_log: error.code ?? 'CALL_CONFIGURATION_FAILED' })
            })
          }
        }
        if (id === 'notifications') await notifications.configure(config)
      } catch (error) {
        settings.setError(id, error)
        throw error
      } finally {
        notify({ type: 'settings', featureId: id })
      }
    }
  }
  const close = async () => {
    if (adminServer) await closeServer(adminServer)
    await closeCallBridge?.()
  }
  return { authMode, authorize: request => authMode(request) === 'local' ? true : cloudflareAuthorize(request), initialize, close }
}
