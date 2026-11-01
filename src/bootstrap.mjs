import { mkdir } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { BotRegistry } from './bot-registry.mjs'
import { restoreBotEnvironments } from './bot-environment.mjs'
import { createGlobalInstructionsRefresher } from './global-instructions.mjs'
import { OwnerProfile } from './owner-profile.mjs'
import { UserRules } from './user-rules.mjs'
import { runtimeHome } from './runtime-home.mjs'
import { FeatureSettings } from './feature-settings.mjs'
import { defaultCallBridgeMcpUrl } from './distribution-profile.mjs'
import { SeatRuntime } from './seat-runtime.mjs'
import { LiveModelCatalog } from './model-catalog.mjs'
import { AitermClient } from './aiterm-client.mjs'

const appRoot = dirname(dirname(fileURLToPath(import.meta.url)))
const home = runtimeHome()
const root = process.env.BELLTEAM_ROOT ?? '/srv/bellteam'
const configPath = process.env.BELLTEAM_BOTS_CONFIG ?? join(appRoot, 'config/bots.json')
// Supervisorと5CLIは同じnative入口を使う。通常18ツールの入口では停止を提供できない。
// 登録の読取失敗を通常入口へのfallbackで隠さず、起動時に返す。
export const seatRuntime = new SeatRuntime({ root, home })
// Scope resolution belongs to the seat too: resolving under UID1001 would
// select a different native state root/socket from the UID1000 CLI hooks.
export const aiterm = await seatRuntime.aitermRegistration()
export const models = new LiveModelCatalog({ cwd: root, client: () => new AitermClient({ ...aiterm, seatProject: root }) })
export const callBridgeHeaders = join(root, 'state/call-bridge/headers')
export const settings = new FeatureSettings({ root, bridgeHeadersPath: callBridgeHeaders, environment: {
  ...process.env,
  BELLTEAM_CALL_BRIDGE_MCP_URL: process.env.BELLTEAM_CALL_BRIDGE_MCP_URL || defaultCallBridgeMcpUrl || '',
} })
await settings.initialize()
const configure = bots => seatRuntime.configureHarnesses(bots, aiterm, settings.configuration('callBridge'))

export const ownerProfile = new OwnerProfile({ root })
await ownerProfile.initialize()
export const userRules = new UserRules({ root })
await userRules.initialize()

export const bots = new BotRegistry({
  seedPath: configPath,
  botsRoot: join(root, 'bots'),
  stateRoot: join(root, 'state/bots'),
  projectFiles: seatRuntime.projectFiles,
  models,
  onChange: configure,
})
await bots.initialize()
await Promise.all([
  mkdir(join(root, 'state'), { recursive: true }),
  mkdir(join(root, 'logs'), { recursive: true }),
  mkdir(join(root, 'shared', 'tools'), { recursive: true }),
])
await seatRuntime.removeClaudeCopies(bots)
await restoreBotEnvironments(bots, { seatCommands: true })
await configure(bots)

export const refreshGlobalInstructions = createGlobalInstructionsRefresher({ ownerProfile, userRules, home,
  write: (home, instructions) => seatRuntime.writeInstructions(home, instructions) })

await refreshGlobalInstructions()
