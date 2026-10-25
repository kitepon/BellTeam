import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { chmod, copyFile, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import test from 'node:test'
import { assessDeployQuiet, checkDeployQuiet, collectDeployTurns, confirmDeployIdle, processDescendants,
  readDeploySeats, readProcTable, readProcTree, trustedIdleTree } from '../scripts/check-deploy-quiet.mjs'

const exec = promisify(execFile)
const nodeExe = '/usr/local/bin/node', relay = '/usr/local/bin/mcp-lazy'
const approval = '/home/bell/.approval-box/runtime/0.1.26/'
const aiterm = '/usr/local/lib/node_modules/aiterm-mcp/dist/index.js'
const root = { pid: 10, ppid: 1, pgid: 10, start: '100', state: 'S',
  exe: '/usr/local/lib/node_modules/@anthropic-ai/claude-code/bin/claude.exe', argv: null, cwd: '/srv/bellteam/bots/bot-peer' }
const hook = { pid: 20, ppid: 10, pgid: 10, start: '110', state: 'S', exe: nodeExe,
  argv: [nodeExe, `${approval}approval-box-claude-hook.mjs`] }
const peerSeat = { botId: 'bot-peer', session: 'peer', candidates: [root, hook].map(({pid, ppid, start, exe}) => ({pid, ppid, start, exe})) }
const idle = { exists: true, state: 'idle', reason: 'composer_ready', pending_child_deliveries: 0,
  launch_id: 'synthetic-launch', harness: 'claude-code',
  harness_process: { pid: 10, process_group_id: 10, started_identity: 'synthetic-start', argv_digest: 'a'.repeat(64) } }
const procFixture = (rows = [root, hook]) => ({ readTable: async () => new Map(rows.map(row => [row.pid, row])),
  readTree: async () => structuredClone(rows), readStart: async () => 'synthetic-start' })

async function statTableFixture(t, count = 65) {
  const proc = await mkdtemp(join(tmpdir(), 'bellteam-proc-table-'))
  t.after(() => rm(proc, {recursive:true, force:true}))
  for (let pid = 1; pid <= count; pid++) {
    const dir = join(proc, String(pid))
    await mkdir(dir)
    const fields = ['S', String(pid === 1 ? 0 : 1), '1', ...Array(16).fill('0'), String(100 + pid)]
    await writeFile(join(dir, 'stat'), `${pid} (fixture name) ${fields.join(' ')}\n`)
  }
  return proc
}

test('列挙後に消えたPIDは不完全表を捨て、全列挙からの完全な一表だけ返す', async () => {
  let lists = 0
  const read = async path => {
    if (path === '/synthetic/99/stat') throw Object.assign(new Error('gone'), {code:'ENOENT',path})
    const pid = Number(path.split('/')[2])
    return `${pid} (fixture) ${['S','0','1',...Array(16).fill('0'),String(lists * 100 + pid)].join(' ')}`
  }
  const table = await readProcTable('/synthetic', { list:async()=>++lists === 1 ? ['1','99'] : ['1','2'], read })
  assert.equal(lists, 2)
  assert.deepEqual([...table.keys()], [1,2])
  assert.equal(table.get(1).start, '201')
  assert.equal(table.get(2).start, '202')
})

test('二度目の欠測は返さず、再列挙は最大二回で止まる', async () => {
  let lists = 0
  await assert.rejects(readProcTable('/synthetic', {
    list:async()=>{ lists++; return ['99'] },
    read:async path=>{throw Object.assign(new Error('gone'), {code:'ENOENT',path})},
  }), {code:'ENOENT'})
  assert.equal(lists, 2)
})

test('権限・不正stat・列挙エラーを消失として取り直さない', async () => {
  for (const mode of ['permission','malformed','listing']) {
    let lists = 0
    await assert.rejects(readProcTable('/synthetic', {
      list:async()=>{ lists++; if(mode==='listing') throw Object.assign(new Error('listing'), {code:'ENOENT',path:'/synthetic'}); return ['1'] },
      read:async path=>{ if(mode==='permission') throw Object.assign(new Error('denied'), {code:'EACCES',path}); return 'invalid' },
    }))
    assert.equal(lists, 1)
  }
})

test('消失と権限・不正statが混在すれば同batch/後続batchとも再列挙しない', async () => {
  for (const offset of [2, 34]) for (const mode of ['permission','malformed']) {
    let lists = 0
    await assert.rejects(readProcTable('/synthetic', {
      list:async()=>{ lists++; return Array.from({length:offset}, (_,i)=>String(i+1)) },
      read:async path=>{
        const pid = Number(path.split('/')[2])
        if(pid===1) throw Object.assign(new Error('gone'), {code:'ENOENT',path})
        if(pid===offset) {
          if(mode==='permission') throw Object.assign(new Error('denied'), {code:'EACCES',path})
          return 'invalid'
        }
        return `${pid} (fixture) ${['S','0','1',...Array(16).fill('0'),'100'].join(' ')}`
      },
    }), mode==='permission' ? {code:'EACCES'} : /DEPLOY_PROCESS_UNKNOWN/u)
    assert.equal(lists,1)
  }
})

test('取り直した完全表でも対象root消失はidleとして許さない', async () => {
  let lists = 0, observed = 0
  const table = await readProcTable('/synthetic', {
    list:async()=>++lists === 1 ? ['10'] : [],
    read:async path=>{throw Object.assign(new Error('gone'), {code:'ENOENT',path})},
  })
  assert.equal(await confirmDeployIdle({observe:async()=>{ observed++; return idle }}, peerSeat,
    {...procFixture(), readTable:async()=>table}), null)
  assert.equal(observed, 1)
})

test('process表は複数batchを含む全PIDの親・開始tickを保持する', async t => {
  const proc = await statTableFixture(t)
  const rows = await readProcTable(proc)
  assert.equal(rows.size, 65)
  for (let pid = 1; pid <= 65; pid++)
    assert.deepEqual(rows.get(pid), {pid, ppid:pid === 1 ? 0 : 1, pgid:1, start:String(100 + pid), state:'S'})
})

test('process表の後ろのbatchにstat欠測が1件あればidle観測前に保留する', async t => {
  const proc = await statTableFixture(t)
  await rm(join(proc, '65', 'stat'))
  await assert.rejects(readProcTable(proc), {code:'ENOENT'})
  const turns = await collectDeployTurns({seatTurns:async()=>null,
    observe:async()=>assert.fail('欠測表からidle観測へ進まない')}, [peerSeat], {
    confirmIdle:(transport, seat)=>confirmDeployIdle(transport, seat, {readTable:()=>readProcTable(proc)}),
  })
  assert.equal(turns.get(peerSeat.session), null)
})

test('process表の後ろのbatchに不正statが1件あれば全表を返さない', async t => {
  const proc = await statTableFixture(t)
  await writeFile(join(proc, '65', 'stat'), '65 (fixture) S 1 1 invalid\n')
  await assert.rejects(readProcTable(proc), /DEPLOY_PROCESS_UNKNOWN/u)
})

test('ターン情報の無いハーネスは構造化idle観測で確認し、既知ターンはそのまま使う', async () => {
  const calls = []
  const turns = await collectDeployTurns({
    seatTurns: async () => new Map([['codex', { state: 'running' }]]),
    observe: async bot => { calls.push(bot.session); return { exists: true, state: 'idle', reason: 'composer_ready',
      activity: { post_startup_process_count: 0 }, pending_child_deliveries: 0 } },
  }, [{ session: 'codex' }, { session: 'claude' }, { session: 'grok' }], {
    confirmIdle: async (transport, seat) => { await transport.observe(seat); return { state: 'idle' } },
  })
  assert.deepEqual(calls, ['claude', 'grok'])
  assert.equal(turns.get('codex').state, 'running')
  assert.equal(turns.get('claude').state, 'idle')
  assert.equal(turns.get('grok').state, 'idle')
})

test('子待ち/状態欠測/identity欠測を入力待ちだけでidle認定しない', async () => {
  for (const observed of [{ ...idle, pending_child_deliveries: 1 },
    { ...idle, pending_child_deliveries: null }, { ...idle, harness_process: null },
    { ...idle, state: 'blocked' }, { ...idle, exists: false }]) {
    const turns = await collectDeployTurns({ seatTurns: async () => null, observe: async () => observed }, [peerSeat],
      { confirmIdle: (transport, seat) => confirmDeployIdle(transport, seat, procFixture()) })
    assert.equal(turns.get('peer'), null)
  }
  const turns = await collectDeployTurns({ seatTurns: async () => null,
    observe: async () => ({ exists: true, state: 'busy' }) }, [peerSeat],
    { confirmIdle: (transport, seat) => confirmDeployIdle(transport, seat, procFixture()) })
  assert.equal(turns.get('peer').state, 'running')
  const stop = new AbortController()
  stop.abort()
  await assert.rejects(collectDeployTurns({ seatTurns: async () => null,
    observe: async () => assert.fail('打切り後に追加の観測を始めない') }, [{ session: 'peer' }], { signal: stop.signal }), /DEPLOY_QUIET_TURNS_UNAVAILABLE/u)
})

test('B案は計数値の0/1/null/欠測に依存せず全子孫と前後観測で確認する', async () => {
  for (const count of [0, 1, 8, null, undefined]) {
    let calls = 0
    const result = await confirmDeployIdle({ observe: async () => { calls++; return { ...idle,
      activity: { post_startup_process_count: count } } } }, peerSeat, procFixture())
    assert.equal(result.state, 'idle')
    assert.equal(calls, 2)
  }
})

test('確認済みMCPは中継と直接子だけ許容し、hookと同居できる', () => {
  for (const args of [[nodeExe, aiterm], [nodeExe, `${approval}cli.mjs`, 'mcp']]) {
    const rows = [root, hook,
      { pid: 30, ppid: 10, pgid: 10, start: '120', state: 'S', exe: relay, argv: [relay, ...args] },
      { pid: 40, ppid: 30, pgid: 30, start: '130', state: 'S', exe: nodeExe, argv: args }]
    assert.equal(trustedIdleTree(rows, 10, 'claude-code', 'bot-peer'), true)
    // 下の任意作業を丸ごとMCPとして捨てない。
    assert.equal(trustedIdleTree([...rows, { pid: 50, ppid: 40, pgid: 30, start: '140', state: 'S', exe: '/usr/bin/python3', argv: null }], 10, 'claude-code', 'bot-peer'), false)
    assert.equal(trustedIdleTree(rows.map(row => row.pid === 40 ? { ...row, argv: [nodeExe, '/other/server.mjs'] } : row), 10, 'claude-code', 'bot-peer'), false)
  }
})

test('登録元の同scope native MCPは待機として扱い、別scopeと余分な作用は拒否する', async () => {
  const nativeRegistration = { command: nodeExe, args: [
    '/usr/local/lib/node_modules/aiterm-mcp/dist/execution-native-server.js',
    '--execution-interrupt', '--state-root', '/tmp/fixture-state',
    '--socket', '/tmp/fixture-socket', '--steer-provider', '/fixture/provider.js',
  ] }
  const command = [nativeRegistration.command, ...nativeRegistration.args]
  const relayRow = { pid: 30, ppid: 10, pgid: 10, start: '120', state: 'S', exe: relay, argv: [relay, ...command] }
  const serverRow = { pid: 40, ppid: 30, pgid: 30, start: '130', state: 'S', exe: nodeExe, argv: command }
  const rows = [root, hook, relayRow, serverRow]
  const seat = { ...peerSeat, nativeRegistration,
    candidates: rows.map(({pid, ppid, start, exe}) => ({pid, ppid, start, exe})) }
  // 修理前は、正規descriptorを渡しても旧index入口だけを認識していた。
  assert.equal(trustedIdleTree(rows, 10, 'claude-code', 'bot-peer'), false)
  assert.equal((await confirmDeployIdle({observe:async()=>idle}, seat, procFixture(rows))).state, 'idle')
  for (const args of [command.map(v=>v==='/tmp/fixture-state'?'/tmp/other-state':v),
    command.map(v=>v==='/tmp/fixture-socket'?'/tmp/other-socket':v),
    command.map(v=>v==='/fixture/provider.js'?'/other/provider.js':v), [...command,'--extra']]) {
    const changed = [root, hook, {...relayRow,argv:[relay,...args]}, {...serverRow,argv:args}]
    assert.equal(await confirmDeployIdle({observe:async()=>idle}, seat, procFixture(changed)), null)
  }
  const work = {pid:50,ppid:40,pgid:30,start:'140',state:'S',exe:'/usr/bin/python3',argv:null}
  assert.equal(await confirmDeployIdle({observe:async()=>idle}, seat, procFixture([...rows,work])), null)
  const stopped = await confirmDeployIdle({observe:async()=>({...idle,state:'busy'})}, seat, procFixture(rows))
  assert.equal(stopped.state, 'running')
})

test('Codexのnode入口と唯一の固定native CLIを区別してMCPの親を確認する', () => {
  const wrapper = { ...root, exe: nodeExe }
  const native = { pid: 11, ppid: 10, pgid: 10, start: '101', state: 'S', argv: null,
    exe: '/usr/local/lib/node_modules/@openai/codex/node_modules/@openai/codex-linux-x64/vendor/x86_64-unknown-linux-musl/bin/codex' }
  const mcp = { pid: 30, ppid: 11, pgid: 10, start: '120', state: 'S', exe: relay, argv: [relay, nodeExe, aiterm] }
  assert.equal(trustedIdleTree([wrapper, native, mcp], 10, 'codex-cli', 'bot-peer'), true)
  assert.equal(trustedIdleTree([wrapper, native, { ...mcp, ppid: 10 }], 10, 'codex-cli', 'bot-peer'), false)
  assert.equal(trustedIdleTree([wrapper, native, { ...native, pid: 12 }], 10, 'codex-cli', 'bot-peer'), false)
  assert.equal(trustedIdleTree([wrapper, { ...native, exe: '/other/codex' }], 10, 'codex-cli', 'bot-peer'), false)
  const helper = { pid: 40, ppid: 11, pgid: 10, start: '130', state: 'S', exe: native.exe + '-code-mode-host', argv: [native.exe + '-code-mode-host'] }
  assert.equal(trustedIdleTree([wrapper, native, mcp, helper], 10, 'codex-cli', 'bot-peer'), true)
  assert.equal(trustedIdleTree([wrapper, native, helper, { ...helper, pid: 50, ppid: 40 }], 10, 'codex-cli', 'bot-peer'), false)
  assert.equal(trustedIdleTree([wrapper, native, { ...helper, argv: [...helper.argv, '--extra'] }], 10, 'codex-cli', 'bot-peer'), false)
})

test('観測identityが固定Codex native直起動なら、そのrootと既知の直接子だけを認識する', () => {
  const exe = '/usr/local/lib/node_modules/@openai/codex/node_modules/@openai/codex-linux-x64/vendor/x86_64-unknown-linux-musl/bin/codex'
  const direct = {...root,exe}
  const mcp = {pid:30,ppid:10,pgid:10,start:'120',state:'S',exe:relay,argv:[relay,nodeExe,aiterm]}
  const helper = {pid:40,ppid:10,pgid:10,start:'130',state:'S',exe:exe+'-code-mode-host',argv:[exe+'-code-mode-host']}
  assert.equal(trustedIdleTree([direct,mcp,helper],10,'codex-cli','bot-peer'),true)
  for (const changed of [{...direct,exe:'/other/codex'}, {...direct,cwd:'/other/project'}, {...direct,state:'T'}])
    assert.equal(trustedIdleTree([changed,mcp,helper],10,'codex-cli','bot-peer'),false)
  assert.equal(trustedIdleTree([direct,mcp,helper,{...direct,pid:50,ppid:10,start:'140'}],10,'codex-cli','bot-peer'),false)
  assert.equal(trustedIdleTree([direct,mcp,{...helper,ppid:30}],10,'codex-cli','bot-peer'),false)
})

test('hookの別root/版/余分引数/別exe/別親/非Claudeと似た名前を拒否する', () => {
  const bad = [
    { ...hook, argv: [nodeExe, '/other/approval-box-claude-hook.mjs'] },
    { ...hook, argv: [nodeExe, `${approval.replace('0.1.26', '0.1.27')}approval-box-claude-hook.mjs`] },
    { ...hook, argv: [...hook.argv, '--extra'] },
    { ...hook, argv: [nodeExe, `${approval}approval-box-claude-hook.mjs.extra`] },
    { ...hook, exe: '/other/node' }, { ...hook, ppid: 999 },
    { ...hook, state: 'T' }, { ...hook, state: 'Z' }, { ...hook, start: '99' },
  ]
  for (const row of bad) assert.equal(trustedIdleTree([root, row], 10, 'claude-code', 'bot-peer'), false)
  assert.equal(trustedIdleTree([root, hook], 10, 'grok-cli', 'bot-peer'), false)
  assert.equal(trustedIdleTree([root, hook], 10, 'claude-code', 'bot-other'), false)
})

test('別作業、hookの下の作業、重複PIDや孤立行を拒否する', () => {
  for (const ppid of [10, 20]) assert.equal(trustedIdleTree([root, hook,
    { pid: 30, ppid, pgid: 10, start: '120', state: 'S', exe: '/usr/bin/bash', argv: null }], 10, 'claude-code', 'bot-peer'), false)
  assert.equal(trustedIdleTree([root, hook, hook], 10, 'claude-code', 'bot-peer'), false)
  assert.equal(trustedIdleTree([root, { ...hook, ppid: 999 }], 10, 'claude-code', 'bot-peer'), false)
  assert.equal(trustedIdleTree([{ ...root, ppid: 20 }, hook], 10, 'claude-code', 'bot-peer'), false)
})

test('同じPIDでも開始tick、親、exeやargvが変われば保留する', async () => {
  for (const changed of [{ ...root, start: '200' }, { ...root, ppid: 2 },
    { ...hook, exe: '/other/node' }, { ...hook, argv: [...hook.argv, 'private-canary'] }]) {
    const fixture = procFixture()
    let n = 0
    fixture.readTree = async () => ++n === 1 ? structuredClone([root, hook])
      : [root, hook].map(row => row.pid === changed.pid ? changed : row)
    const result = await confirmDeployIdle({ observe: async () => idle }, peerSeat, fixture)
    assert.equal(result, null)
    assert.doesNotMatch(JSON.stringify(result), /private-canary/u)
  }
})

test('前後観測で番/親identity/launch/子待ちが変わったら通さない', async () => {
  for (const after of [{ ...idle, state: 'busy' }, { ...idle, pending_child_deliveries: 1 },
    { ...idle, launch_id: 'replacement' }, { ...idle, harness_process: { ...idle.harness_process, argv_digest: 'b'.repeat(64) } }]) {
    let n = 0
    const result = await confirmDeployIdle({ observe: async () => ++n === 1 ? idle : after },
      peerSeat, procFixture())
    assert.notEqual(result?.state, 'idle')
  }
  const fixture = procFixture()
  fixture.readStart = async () => 'different-start'
  assert.equal(await confirmDeployIdle({ observe: async () => idle }, peerSeat, fixture), null)
})

test('最後の観測中に現れた子孫も再読取りで検出する', async () => {
  const fixture = procFixture()
  let n = 0
  fixture.readTree = async () => ++n < 3 ? structuredClone([root, hook]) : [root, hook,
    { pid: 30, ppid: 10, pgid: 10, start: '120', state: 'S', exe: '/usr/bin/bash', argv: null }]
  assert.equal(await confirmDeployIdle({ observe: async () => idle }, peerSeat, fixture), null)
})

test('process読取失敗は秘密を出さず未分類にする', async () => {
  const turns = await collectDeployTurns({ seatTurns: async () => null }, [{ botId: 'bot-peer', session: 'peer' }],
    { confirmIdle: () => { throw new Error('private-canary') } })
  assert.equal(turns.get('peer'), null)
  assert.doesNotMatch(JSON.stringify([...turns]), /private-canary/u)
})

test('/proc fixtureは全子孫を読み、CLI本体の初手argvを読まない', async t => {
  const proc = await mkdtemp(join(tmpdir(), 'bellteam-proc-idle-'))
  t.after(() => rm(proc, { recursive: true, force: true }))
  for (const row of [root, hook]) {
    const path = join(proc, String(row.pid))
    await mkdir(path)
    await symlink(row.exe, join(path, 'exe'))
    const fields = [row.state, row.ppid, row.pgid, ...Array(16).fill(0), row.start]
    await writeFile(join(path, 'stat'), `${row.pid} (fixture (nested) name) ${fields.join(' ')}\n`)
    // 本体cmdlineをわざと作らない。読もうとすればfixtureが失敗する。
    if (row.pid === 10) await symlink(row.cwd, join(path, 'cwd'))
    else await writeFile(join(path, 'cmdline'), row.argv.join('\0') + '\0')
  }
  const table = await readProcTable(proc)
  assert.deepEqual(processDescendants(table, 10).map(row => row.pid), [10, 20])
  assert.equal(trustedIdleTree(await readProcTree(table, 10, proc), 10, 'claude-code', 'bot-peer'), true)
  await rm(join(proc, '20/stat'))
  await assert.rejects(readProcTable(proc))
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
  assert.deepEqual(calls, ['queue', 'process', 'turns', 'process', 'queue'])
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
  for (const [pid, id, executable] of [['1', 'bot-peer', 'codex'], ['2', 'bot-missing', 'claude'], ['3', 'bot-self', 'codex'], ['4', 'bot-helper', 'python3']]) {
    await mkdir(join(proc, pid))
    await symlink(join(bots, id), join(proc, pid, 'cwd'))
    await symlink(`/synthetic/${executable}`, join(proc, pid, 'exe'))
    const fields = ['S', 0, Number(pid), ...Array(16).fill(0), '100']
    await writeFile(join(proc, pid, 'stat'), `${pid} (fixture) ${fields.join(' ')}\n`)
    // CLIのcmdlineは作らない。席探索からargvを読もうとすれば失敗する。
  }
  await mkdir(join(bots, 'bot-peer'))
  await writeFile(join(bots, 'bot-peer', 'bot.json'), JSON.stringify({ id: 'bot-peer', session: 'different-seat-name', name:'待機の担当', profileText: 'synthetic-private-profile' }))
  const result = await readDeploySeats({ proc, root: bots, except: 'bot-self' })
  assert.deepEqual(result, { seats: [{ botId: 'bot-peer', name:'待機の担当', session: 'different-seat-name', project: `${bots}/bot-peer`, candidates: [{pid: 1, ppid: 0, start: '100', exe: '/synthetic/codex'}] }, { botId: 'bot-missing', session: null, project: `${bots}/bot-missing`, candidates: [{pid: 2, ppid: 0, start: '100', exe: '/synthetic/claude'}] }], unknown: 0 })
  assert.doesNotMatch(JSON.stringify(result), /synthetic-private-profile/u)
})

test('CLI入口の入力不正は秘密を含まない固定警告とexit2で止まる', async () => {
  await assert.rejects(exec(process.execPath, ['scripts/check-deploy-quiet.mjs', 'invalid'], { cwd: new URL('..', import.meta.url) }), error => {
    assert.equal(error.code, 2)
    assert.equal(error.stderr, 'DEPLOY_QUIET_UNAVAILABLE\n')
    return true
  })
})

test('席探索から判定まで根CLIのcmdline無しで通し、同Botの別CLI rootを保留する', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'bellteam-quiet-end-to-end-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const proc = join(directory, 'proc'), bots = join(directory, 'bots'), project = join(bots, 'bot-peer')
  await mkdir(proc)
  await mkdir(project, { recursive: true })
  await writeFile(join(project, 'bot.json'), JSON.stringify({ id: 'bot-peer', session: 'peer' }))
  const add = async row => {
    const path = join(proc, String(row.pid))
    await mkdir(path)
    await symlink(row.exe, join(path, 'exe'))
    await symlink(project, join(path, 'cwd'))
    const fields = [row.state, row.ppid, row.pgid, ...Array(16).fill(0), row.start]
    await writeFile(join(path, 'stat'), `${row.pid} (fixture) ${fields.join(' ')}\n`)
    if (row.argv) await writeFile(join(path, 'cmdline'), row.argv.join('\0') + '\0')
  }
  await add(root)
  await add(hook)
  const run = async state => checkDeployQuiet({ except: 'bot-self', fetchQueue: async () => [],
    readSeats: () => readDeploySeats({ proc, root: bots, except: 'bot-self' }),
    readSeatTurns: seats => collectDeployTurns({ seatTurns: async () => new Map([['peer', state]]), observe: async () => idle }, seats,
      { confirmIdle: (transport, seat) => confirmDeployIdle(transport, seat,
        { readTable: () => readProcTable(proc), readTree: (table, pid) => readProcTree(table, pid, proc), readStart: async () => 'synthetic-start' }) }),
  })
  assert.equal((await run(null)).quiet, true)
  assert.equal((await run({ state: 'idle' })).quiet, true)
  await add({ ...root, pid: 50, ppid: 1, start: '150' })
  for (const state of [null, { state: 'idle' }]) {
    const result = await run(state)
    assert.equal(result.quiet, false)
    assert.deepEqual(result.unclassifiedBots, ['bot-peer'])
  }
})

test('観測中に別rootが現れた場合も最後の席探索で保留する', async () => {
  let reads = 0
  const result = await checkDeployQuiet({ except: 'bot-self', fetchQueue: async () => [],
    readSeats: async () => ({ unknown: 0, seats: [{ ...peerSeat, candidates: ++reads === 1 ? peerSeat.candidates
      : [...peerSeat.candidates, {pid: 50, ppid: 1, start: '150', exe: root.exe}] }] }),
    readSeatTurns: async () => new Map([['peer', { state: 'idle' }]]),
  })
  assert.equal(result.quiet, false)
  assert.deepEqual(result.unclassifiedBots, ['bot-peer'])
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
  if [ "$count" = "$FIXTURE_BLOCK_AT" ]; then
    printf '%s\\n' '{"diagnostics":[{"reason":"table_stat_missing"}]}'
    exit 2
  fi
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
      assert.match(stdout, /table_stat_missing/u)
    }
  }
})

for (const localNode of ['environment/node_modules/node/bin/node', 'environment/node-v22.23.4/bin/node']) {
  test(`同じBotの${localNode} wrapperでも唯一の公式Codex子と全子孫を確認する`, () => {
    const wrapper = { ...root, exe: `/srv/bellteam/bots/bot-peer/${localNode}` }
    const native = { pid: 11, ppid: 10, pgid: 10, start: '101', state: 'S', argv: null,
      exe: '/usr/local/lib/node_modules/@openai/codex/node_modules/@openai/codex-linux-x64/vendor/x86_64-unknown-linux-musl/bin/codex' }
    const mcp = { pid: 30, ppid: 11, pgid: 10, start: '120', state: 'S', exe: relay, argv: [relay, nodeExe, aiterm] }
    assert.equal(trustedIdleTree([wrapper,native,mcp],10,'codex-cli','bot-peer'),true)
    for(const changed of [[],[{...native,exe:'/other/codex'}],[native,{...native,pid:12}],[native,{...mcp,ppid:10}],
      [native,mcp,{pid:40,ppid:11,pgid:10,start:'130',state:'S',exe:nodeExe,argv:[nodeExe,'/work/task.mjs']}],
      [{...native,state:'Z'}]]) assert.equal(trustedIdleTree([wrapper,...changed],10,'codex-cli','bot-peer'),false)
    for(const exe of ['/srv/bellteam/bots/bot-other/environment/node_modules/node/bin/node',
      '/srv/bellteam/bots/bot-peer/other/node','/srv/bellteam/bots/bot-peer/environment/node-v22.23.4/bin/other'])
      assert.equal(trustedIdleTree([{...wrapper,exe},native,mcp],10,'codex-cli','bot-peer'),false)
  })
}
