#!/usr/bin/env node
import { dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import * as bootstrap from './bootstrap.mjs'
import { createApplicationRuntime } from './application-runtime.mjs'
import { waitForShutdown } from './lifecycle.mjs'

const runtime = await createApplicationRuntime({
  root: process.env.BELLTEAM_ROOT ?? '/srv/bellteam',
  appRoot: dirname(dirname(fileURLToPath(import.meta.url))),
  bootstrap,
})
await runtime.start()
process.stderr.write('BellTeam ready\n')
await waitForShutdown()
await runtime.close()
