import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { chmod, copyFile, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import test from 'node:test'
import { assessDeployQuiet, checkDeployQuiet, collectDeployTurns, readDeploySeats } from '../scripts/check-deploy-quiet.mjs'

const exec = promisify(execFile)

test('ターン情報の無いハーネスは構造化idle観測で確認し、既知ターンはそのまま使う', async () => {
  const calls = []
  const turns = await collectDeployTurns({
    seatTurns: async () => new Map([['codex', { state: 'running' }]]),
    observe: async bot => { calls.push(bot.session); return { exists: true, state: 'idle', reason: 'composer_ready',
      activity: { post_startup_process_count: 0 }, pending_child_deliveries: 0 } },
  }, [{ session: 'codex' }, { session: 'claude' }, { session: 'grok' }])
  assert.deepEqual(calls, ['claude', 'grok'])
  assert.equal(turns.get('codex').state, 'running')
  assert.equal(turns.get('claude').state, 'idle')
  assert.equal(turns.get('grok').state, 'idle')
})

test('観測にhook/子待ち/欠測が残る時は入力待ちだけでidle認定しない', async () => {
  const idle = { exists: true, state: 'idle', reason: 'composer_ready',
    activity: { post_startup_process_count: 0 }, pending_child_deliveries: 0 }
  for (const observed of [{ ...idle, activity: { post_startup_process_count: 1 } },
    { ...idle, pending_child_deliveries: 1 }, { ...idle, activity: {} },
    { ...idle, state: 'blocked' }, { ...idle, exists: false }]) {
    const turns = await collectDeployTurns({ seatTurns: async () => null, observe: async () => observed }, [{ session: 'peer' }])
    assert.equal(turns.get('peer'), null)
  }
  const turns = await collectDeployTurns({ seatTurns: async () => null,
    observe: async () => ({ exists: true, state: 'busy' }) }, [{ session: 'peer' }])
  assert.equal(turns.get('peer').state, 'running')
  const stop = new AbortController()
  stop.abort()
  await assert.rejects(collectDeployTurns({ seatTurns: async () => null,
    observe: async () => assert.fail('打切り後に追加の観測を始めない') }, [{ session: 'peer' }], { signal: stop.signal }), /DEPLOY_QUIET_TURNS_UNAVAILABLE/u)
})

test('待機CLIが22席残っていても、自席だけのターンなら静かな条件を満たす', () => {
  const seats = Array.from({ length: 22 }, (_, i) => ({ botId: `bot-idle-${i}`, session: `seat-${i}` }))
  const turns = new Map(seats.map(seat => [seat.session, { state: 'idle' }]))
  seats.push({ botId: 'bot-self', session: 'self' })
  turns.set('self', { state: 'running' })
  const result = assessDeployQuiet({ except: 'bot-self', items: [{ botId: 'bot-self', status: 'running' }], seats, turns })
  assert.equal(result.quiet, true)
  assert.deepEqual(result.otherBotCliOrQueued, [])
})

test('配送queueに無い自発ターンも途中なら反映を止める', () => {
  const result = assessDeployQuiet({ except: 'bot-self', items: [],
    seats: [{ botId: 'bot-peer', session: 'peer' }], turns: new Map([['peer', { state: 'running', turn_id: 'synthetic' }]]) })
  assert.equal(result.quiet, false)
  assert.deepEqual(result.runningBots, ['bot-peer'])
})

test('idleでも他席のrunning・steered・待機配送はすべて止める', () => {
  for (const status of ['running', 'steered', 'queued']) {
    const result = assessDeployQuiet({ except: 'bot-self', items: [{ botId: 'bot-peer', status }],
      seats: [{ botId: 'bot-peer', session: 'peer' }], turns: new Map([['peer', { state: 'idle' }]]) })
    assert.equal(result.quiet, false)
    assert.deepEqual(result.queuedBots, ['bot-peer'])
  }
})

test('未対応・欠測・不明state・席名欠損をidleと推測せず保留する', () => {
  for (const turn of [null, undefined, {}, { state: 'unknown' }]) {
    const result = assessDeployQuiet({ except: 'bot-self', items: [],
      seats: [{ botId: 'bot-peer', session: 'peer' }], turns: new Map([['peer', turn]]) })
    assert.equal(result.quiet, false)
    assert.deepEqual(result.unclassifiedBots, ['bot-peer'])
  }
  assert.equal(assessDeployQuiet({ except: 'bot-self', items: [], seats: [{ botId: 'bot-peer', session: null }], turns: null }).quiet, false)
  assert.equal(assessDeployQuiet({ except: 'bot-self', items: [null], seats: [], turns: null }).quiet, false)
  assert.equal(assessDeployQuiet({ except: 'bot-self', items: [], seats: [], turns: null, unknown: 1 }).quiet, false)
})

test('状態読取中に入った配送を後のqueueで見つけ、読取失敗も保留する', async () => {
  const calls = []
  const result = await checkDeployQuiet({ except: 'bot-self',
    fetchQueue: async () => { calls.push('queue'); return calls.length === 1 ? [] : [{ botId: 'bot-peer', status: 'steered' }] },
    readSeats: async () => { calls.push('process'); return { seats: [{ botId: 'bot-peer', session: 'peer' }], unknown: 0 } },
    readSeatTurns: async () => { calls.push('turns'); return new Map([['peer', { state: 'idle' }]]) },
  })
  assert.deepEqual(calls, ['queue', 'process', 'turns', 'queue'])
  assert.equal(result.quiet, false)
  const failed = await checkDeployQuiet({ except: 'bot-self', fetchQueue: async () => [],
    readSeats: async () => ({ seats: [{ botId: 'bot-peer', session: 'peer' }], unknown: 0 }),
    readSeatTurns: async () => { throw new Error('synthetic-private-error') },
  })
  assert.deepEqual(failed.unclassifiedBots, ['bot-peer'])
  assert.doesNotMatch(JSON.stringify(failed), /synthetic-private-error/u)
})

test('席が無い時はAiterm読取不要、queue不正や読取失敗は成功にしない', async () => {
  const result = await checkDeployQuiet({ except: 'bot-self', fetchQueue: async () => [],
    readSeats: async () => ({ seats: [], unknown: 0 }), readSeatTurns: async () => { assert.fail('席の無い時に呼ばない') } })
  assert.equal(result.quiet, true)
  await assert.rejects(checkDeployQuiet({ except: 'bot-self', fetchQueue: async () => null,
    readSeats: async () => ({ seats: [], unknown: 0 }) }), /DEPLOY_QUIET_QUEUE_INVALID/u)
  await assert.rejects(checkDeployQuiet({ except: 'bot-self', fetchQueue: async () => { throw new Error('offline') } }), /offline/u)
})

test('processから席名を対応づけ、設定欠損を無視せず、他processと自席を除く', async t => {
  const root = await mkdtemp(join(tmpdir(), 'bellteam-quiet-process-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const proc = join(root, 'proc'), bots = join(root, 'bots')
  await mkdir(proc)
  await mkdir(bots)
  for (const [pid, id, executable] of [['1', 'bot-peer', 'codex'], ['2', 'bot-missing', 'claude'], ['3', 'bot-self', 'codex'], ['4', 'bot-helper', 'node']]) {
    await mkdir(join(proc, pid))
    await symlink(join(bots, id), join(proc, pid, 'cwd'))
    await symlink(`/synthetic/${executable}`, join(proc, pid, 'exe'))
    await writeFile(join(proc, pid, 'cmdline'), executable + '\0')
  }
  await mkdir(join(bots, 'bot-peer'))
  await writeFile(join(bots, 'bot-peer', 'bot.json'), JSON.stringify({ id: 'bot-peer', session: 'different-seat-name', profileText: 'synthetic-private-profile' }))
  const result = await readDeploySeats({ proc, root: bots, except: 'bot-self' })
  assert.deepEqual(result, { seats: [{ botId: 'bot-peer', session: 'different-seat-name' }, { botId: 'bot-missing', session: null }], unknown: 0 })
  assert.doesNotMatch(JSON.stringify(result), /synthetic-private-profile/u)
})

test('CLI入口の入力不正は秘密を含まない固定警告とexit2で止まる', async () => {
  await assert.rejects(exec(process.execPath, ['scripts/check-deploy-quiet.mjs', 'invalid'], { cwd: new URL('..', import.meta.url) }), error => {
    assert.equal(error.code, 2)
    assert.equal(error.stderr, 'DEPLOY_QUIET_UNAVAILABLE\n')
    return true
  })
})

test('quiet反映はCursor更新前と本体up前の両方で静かな条件を確かめる', async t => {
  const root = await mkdtemp(join(tmpdir(), 'bellteam-deploy-quiet-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  await mkdir(join(root, 'scripts'))
  await mkdir(join(root, 'bin'))
  for (const name of ['check-deploy-quiet.sh', 'check-deploy-quiet.mjs', 'update-cursor.sh'])
    await copyFile(new URL(`../scripts/${name}`, import.meta.url), join(root, 'scripts', name))
  const deploy = await readFile(new URL('../scripts/deploy.sh', import.meta.url), 'utf8')
  const command = deploy.match(/setsid nohup sh -c '(.*?)'/u)?.[1]
  assert.ok(command, '本番の反映命令を検査する')
  const pipeline = command.replaceAll('$quiet_check', 'sh scripts/check-deploy-quiet.sh bot-fixture')
    .replaceAll('\\$?', '$?')
  await writeFile(join(root, 'bin/docker'), `#!/bin/sh
printf '%s\\n' "$*" >> "$FIXTURE_COMMANDS"
if [ "$1" = exec ]; then
  count=$(cat "$FIXTURE_COUNT")
  count=$((count+1)); printf '%s' "$count" > "$FIXTURE_COUNT"
  cat >/dev/null
  if [ "$count" = "$FIXTURE_BLOCK_AT" ]; then exit 2; fi
fi
if [ "$2" = config ] && [ "$3" = --images ]; then echo fixture-server; fi
if [ "$2" = config ] && [ "$3" = --format ]; then printf '%s\\n' 'name: fixture' 'volumes:' '  cursor-cli:' '    name: fixture-cursor'; fi
`)
  await chmod(join(root, 'bin/docker'), 0o755)
  const commands = join(root, 'commands'), counter = join(root, 'count')
  for (const blockAt of ['1', '2', '0']) {
    await writeFile(commands, '')
    await writeFile(counter, '0')
    const { stdout } = await exec('sh', ['-c', pipeline], { cwd: root,
      env: { ...process.env, PATH: `${join(root, 'bin')}:${process.env.PATH}`,
        FIXTURE_COMMANDS: commands, FIXTURE_COUNT: counter, FIXTURE_BLOCK_AT: blockAt } })
    const calls = await readFile(commands, 'utf8')
    if (blockAt === '1') assert.doesNotMatch(calls, /--no-deps cursor-update/u)
    else assert.match(calls, /--no-deps cursor-update/u)
    if (blockAt === '0') {
      assert.match(calls, /compose up -d --no-build/u)
      assert.match(stdout, /deploy-exit=0/u)
    } else {
      assert.doesNotMatch(calls, /compose up/u)
      assert.match(stdout, /deploy-exit=2/u)
    }
  }
})
