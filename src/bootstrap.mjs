import { mkdir } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { BotRegistry } from './bot-registry.mjs'
import { removeSeatClaudeCopies, restoreBotEnvironments } from './bot-environment.mjs'
import { configureHarnesses } from './harness-config.mjs'
import { createGlobalInstructionsRefresher } from './global-instructions.mjs'
import { OwnerProfile } from './owner-profile.mjs'
import { UserRules } from './user-rules.mjs'
import { runtimeHome } from './runtime-home.mjs'
import { FeatureSettings } from './feature-settings.mjs'
import { defaultCallBridgeMcpUrl } from './distribution-profile.mjs'

const appRoot = dirname(dirname(fileURLToPath(import.meta.url)))
const home = runtimeHome()
const root = process.env.BELLTEAM_ROOT ?? '/srv/bellteam'
const configPath = process.env.BELLTEAM_BOTS_CONFIG ?? join(appRoot, 'config/bots.json')
export const settings = new FeatureSettings({ root, environment: {
  ...process.env,
  BELLTEAM_CALL_BRIDGE_MCP_URL: process.env.BELLTEAM_CALL_BRIDGE_MCP_URL || defaultCallBridgeMcpUrl || '',
} })
await settings.initialize()
const configure = bots => configureHarnesses(bots, home, { callBridge: settings.configuration('callBridge') })

export const ownerProfile = new OwnerProfile({ root })
await ownerProfile.initialize()
export const userRules = new UserRules({ root })
await userRules.initialize()

export const bots = new BotRegistry({
  seedPath: configPath,
  botsRoot: join(root, 'bots'),
  onChange: configure,
})
await bots.initialize()
await Promise.all([
  mkdir(join(root, 'state'), { recursive: true }),
  mkdir(join(root, 'logs'), { recursive: true }),
  mkdir(join(root, 'shared', 'tools'), { recursive: true }),
])
await removeSeatClaudeCopies(bots)
await restoreBotEnvironments(bots)
await configure(bots)

export const refreshGlobalInstructions = createGlobalInstructionsRefresher({ ownerProfile, userRules, home })

await refreshGlobalInstructions()
