import assert from 'node:assert/strict'
import test from 'node:test'
import { createTerminalKeyHolder, TERMINAL_AGENT_PATH, AUTH_CLIENT } from '../src/terminal-key-holder.mjs'

const LIST = '256 SHA256:aaa fox (ED25519)\n256 SHA256:bbb macbook (ED25519)\n'
function rig({ list = LIST, holderResults = [] } = {}) {
  const calls = []
  let clock = 0
  const holderRuns = []
  const run = async (command, args, options) => {
    calls.push([command, args])
    if (command === AUTH_CLIENT) {
      holderRuns.push(args)
      const next = holderResults.shift()
      if (next === 'hang') return new Promise((_, reject) => options.signal.addEventListener('abort', () => reject(Object.assign(new Error('abort'), { code: 'ABORT_ERR' }))))
      if (next instanceof Error) throw next
      return { stdout: '' }
    }
    return { stdout: typeof list === 'function' ? list() : list, code: 0 }
  }
  const holder = createTerminalKeyHolder({ run, now: () => clock, sleep: async ms => { clock += ms } })
  return { holder, calls, holderRuns, tick: ms => { clock += ms } }
}

test('the holder script makes the link folder first and repoints the link (a fresh container has no /tmp/bellteam-terminals)', async () => {
  const { holder, holderRuns } = rig({ holderResults: ['hang'] })
  void holder.start()
  await new Promise(resolve => setImmediate(resolve))
  const script = holderRuns[0][holderRuns[0].indexOf('-c') + 1]
  assert.match(script, /^mkdir -p -m 700 "\$\(dirname "\$1"\)" && ln -sf /u)
  const { mkdtemp, readlink } = await import('node:fs/promises'); const { spawnSync } = await import('node:child_process'); const { tmpdir } = await import('node:os'); const { join } = await import('node:path')
  const dir = await mkdtemp(join(tmpdir(), 'holder-'))
  const link = join(dir, 'new', 'agent', 'module.sock')
  const run = spawnSync('/bin/sh', ['-c', script.split('; trap')[0], 'x', link], { env: { SSH_AUTH_SOCK: '/dev/shm/auth-x/agent.sock', PATH: '/usr/bin:/bin' } })
  assert.equal(run.status, 0)
  assert.equal(await readlink(link), '/dev/shm/auth-x/agent.sock')
  holder.stop()
})

test('owns only the three terminals; agentSocket is the one stable path; an unknown terminal is refused', async () => {
  const { holder } = rig({ holderResults: ['hang'] })
  assert.deepEqual(['fox-windows', 'macbook', 'rabbit-linux', 'other'].map(holder.owns), [true, true, true, false])
  assert.equal(holder.agentSocket('fox-windows'), TERMINAL_AGENT_PATH)
  assert.equal(holder.agentSocket('rabbit-linux'), TERMINAL_AGENT_PATH)
  assert.throws(() => holder.agentSocket('other'), { code: 'KEY_NOT_MEDIATED' })
  holder.stop()
})

test('available = the agent lists that terminal\'s key; the holder starts once, with the three names and the stable path; listing is shared and cached', async () => {
  const { holder, calls, holderRuns, tick } = rig({ holderResults: ['hang'] })
  assert.deepEqual(await Promise.all(['fox-windows', 'macbook', 'rabbit-linux'].map(id => holder.available(id))), [{ available: true, revision: 1 }, { available: true, revision: 1 }, { available: false, revision: 1 }])
  assert.equal(holderRuns.length, 1)
  assert.deepEqual(holderRuns[0].slice(0, 3), ['ssh', 'fox,macbook,rabbit', '--'])
  assert.equal(holderRuns[0].at(-1), TERMINAL_AGENT_PATH)
  const listings = () => calls.filter(([command]) => command === '/usr/bin/env')
  assert.equal(listings().length, 1, 'three callers, one ssh-add')
  assert.deepEqual(listings()[0][1], [`SSH_AUTH_SOCK=${TERMINAL_AGENT_PATH}`, 'ssh-add', '-l'])
  await holder.available('fox-windows'); assert.equal(listings().length, 1, 'cached')
  tick(16_000); await holder.available('fox-windows'); assert.equal(listings().length, 2)
  assert.deepEqual(await holder.available('other'), { available: false, revision: 1 })
  holder.stop()
})

test('no agent or no identities is unavailable and never throws; it is looked at again after 3 s', async () => {
  let output = ''
  const { holder, tick } = rig({ list: () => output, holderResults: ['hang'] })
  assert.equal((await holder.available('macbook')).available, false)
  output = LIST
  assert.equal((await holder.available('macbook')).available, false, 'still the empty answer')
  tick(3500)
  assert.equal((await holder.available('macbook')).available, true)
  holder.stop()
})

test('a holder that exits is started again, with a backoff that grows while it keeps failing', async () => {
  const waits = []
  let clock = 0, runs = 0
  const run = async (command, args, options) => { if (command !== AUTH_CLIENT) return { stdout: '' }; runs++; if (runs < 4) throw new Error('module down'); return new Promise((_, reject) => options.signal.addEventListener('abort', () => reject(new Error('abort')))) }
  const reports = []
  const holder = createTerminalKeyHolder({ run, now: () => clock, sleep: async ms => { waits.push(ms) }, report: report => reports.push(report) })
  void holder.start()
  for (let i = 0; i < 20 && runs < 4; i++) await new Promise(resolve => setImmediate(resolve))
  assert.deepEqual(waits, [2000, 4000, 8000])
  assert.equal(reports.length, 1, 'one report for a failing streak')
  holder.stop()
})

test('a rejecting report callback does not trigger an unhandled rejection or stop retries', async () => {
  let runs = 0
  const run = async (command, args, options) => {
    if (command !== AUTH_CLIENT) return { stdout: '' }
    runs++
    if (runs < 3) throw new Error('socket missing')
    return new Promise((_, reject) => options.signal.addEventListener('abort', () => reject(new Error('abort'))))
  }
  const holder = createTerminalKeyHolder({
    run, now: () => 0, sleep: async () => {},
    report: () => Promise.reject(new Error('DIAGNOSTIC_INVALID')),
  })
  void holder.start()
  for (let i = 0; i < 20 && runs < 3; i++) await new Promise(resolve => setImmediate(resolve))
  assert.equal(runs, 3)
  holder.stop()
})
