import { once } from 'node:events'
import { createServer } from 'node:http'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawn } from 'node:child_process'
import { createUsageServices } from '../src/usage/services.mjs'
import { createUsageProjection } from '../src/usage/projection.mjs'
import { createUsageFacade } from '../src/usage/facade.mjs'
import { createUsageApi } from '../src/usage/http-api.mjs'
import { respondHttpError } from '../src/http-errors.mjs'

const root = await mkdtemp(join(tmpdir(), 'bellteam-windows-contact-'))
const bots = new Map(), projection = createUsageProjection({ bots })
let active = false
const service = createUsageServices({ root, bots, rooms: new Map(), environment: {},
  onProjection: row => { if (active) projection.accept(row, 'test-generation') },
  effect: async method => method === 'backgroundAgent.models' ? [{ id: 'synthetic-high-only', efforts: ['high'] }] : null })
let server
try {
  projection.seed(await service.initializeSettings(), 'test-generation')
  await service.initialize(); projection.begin('test-generation')
  for (const row of service.snapshot()) projection.accept(row, 'test-generation')
  projection.commit('test-generation'); active = true
  const facade = createUsageFacade({ projection, request: (method, params, actor) => service.request(method, params, actor) })
  const api = createUsageApi({ settings: facade.settings, captureUsageContext: () => ({ kind: 'owner', botId: null }) })
  server = createServer(async (request, response) => {
    try { await api(request, response, new URL(request.url, 'http://localhost')) }
    catch (error) { await respondHttpError(request, response, error) }
  })
  server.listen(0, '127.0.0.1'); await once(server, 'listening')
  const address = `http://127.0.0.1:${server.address().port}/`
  const child = spawn('dotnet', ['run', '--project', 'windows/BellTeam.UiChecks/BellTeam.UiChecks.csproj', '--', '--background-api', address], { stdio: 'inherit' })
  const [code] = await once(child, 'exit')
  if (code !== 0) throw new Error(`Windows API接点の検証が失敗しました: ${code}`)
} finally {
  if (server) await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()))
  await service.quiesce(); service.close()
  await rm(root, { recursive: true, force: true })
}
