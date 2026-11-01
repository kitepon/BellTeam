import assert from 'node:assert/strict'
import { spawn, execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import test from 'node:test'
import { assertStateWritersStopped, stateWriterPlan, stateWriterSources } from '../src/server-state-writers.mjs'

const config = { services: { bellteam: { environment: { SECRET: 'synthetic$only' }, volumes: [
  { type: 'bind', source: '/runtime/data$KEEP', target: '/srv/bellteam' },
  { type: 'bind', source: '/runtime/home$$KEEP', target: '/home/bell' },
  { type: 'volume', source: 'cursor-cli', target: '/home/bell/.local' },
] } }, volumes: { 'cursor-cli': { name: 'fixture_cursor-cli' } } }

async function composePlan() {
  const child = spawn(process.execPath, [process.env.WRITER_CLI_UNDER_TEST
    ?? new URL('../src/server-state-writers.mjs', import.meta.url).pathname, 'plan'])
  const output = [], errors = []
  child.stdout.on('data', chunk => output.push(chunk))
  child.stderr.on('data', chunk => errors.push(chunk))
  const closed = new Promise((resolve, reject) => { child.once('error', reject); child.once('close', resolve) })
  // Compose config escapes every dollar in its serialized output, including keys.
  child.stdin.end(JSON.stringify(config).replaceAll('$', () => '$$'))
  assert.equal(await closed, 0)
  assert.equal(Buffer.concat(errors).toString(), '')
  assert.doesNotMatch(Buffer.concat(output).toString(), /SECRET|synthetic/)
  return JSON.parse(Buffer.concat(output))
}

test('Compose plan CLI restores literal single and repeated dollars without changing the object API', async () => {
  assert.deepEqual(await composePlan(), stateWriterPlan(config))
  assert.equal(stateWriterPlan(config).roots[1], '/runtime/home$$KEEP')
})

test('Compose plan identifies a running writer at the actual dollar-containing host path', async () => {
  const plan = await composePlan()
  const containers = [{ id: 'synthetic-writer', running: true, restarting: false, restartPolicy: 'no',
    mounts: [{ Type: 'bind', Source: '/runtime/data$KEEP', RW: true }] }]
  const canonical = stateWriterSources(plan, containers).map(source => ({ source, canonical: source }))
  assert.throws(() => assertStateWritersStopped(plan, containers, canonical),
    error => error.message === 'SERVER_STATE_WRITERS_RUNNING' && error.writers[0] === 'synthetic-writer')
})

test('real Compose preserves maintenance shell variables instead of interpolating host values', async () => {
  const file = new URL('../compose.state-maintenance.json', import.meta.url).pathname
  const compose = resolve(process.env.TEST_COMPOSE ?? '../../integrations/docker-compose/bin/docker-compose')
  const declared = JSON.parse(await readFile(file, 'utf8')).services['state-maintenance'].entrypoint
  const { stdout, stderr } = await promisify(execFile)(compose, ['-f', file, 'config', '--format', 'json'], {
    env: { ...process.env, root: 'host-value-must-not-be-used', BELLTEAM_SERVER_IMAGE: 'fixture:current' },
  })
  assert.equal(stderr, '')
  const effective = JSON.parse(stdout.replaceAll('$$', '$')).services['state-maintenance'].entrypoint
  assert.deepEqual(effective, declared.map(value => value.replaceAll('$$', '$')))
  assert.match(effective[5], /flock -x -n -E 75 \/srv\/bellteam-private/)
  assert.doesNotMatch(effective[5], /host-value-must-not-be-used/)
})
