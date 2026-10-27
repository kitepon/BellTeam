import test from 'node:test'
import assert from 'node:assert/strict'
import { trustedIdleTree } from '../scripts/check-deploy-quiet.mjs'

const node = '/usr/local/bin/node'
const codex = '/usr/local/lib/node_modules/@openai/codex/node_modules/@openai/codex-linux-x64/vendor/x86_64-unknown-linux-musl/bin/codex'
const caveat = '/srv/bellteam/shared/tools/caveat/0.21.5/node_modules/caveat-cli/dist/caveat.js'
const root = { pid:10, ppid:1, pgid:10, start:'100', state:'S', exe:codex, cwd:'/srv/bellteam/bots/bot-peer', argv:null }
const server = { pid:20, ppid:10, pgid:10, start:'110', state:'S', exe:node,
  argv:[node, '--disable-warning=ExperimentalWarning', caveat, 'mcp-server'] }
const trusted = rows => trustedIdleTree(rows, 10, 'codex-cli', 'bot-peer')

test('existing exact Caveat direct MCP is an idle child', () => {
  assert.equal(trusted([root, server]), true)
})

test('Caveat argv, parent and version changes remain untrusted', () => {
  for (const argv of [server.argv.slice(0,-1), [...server.argv,'sync'],
    server.argv.map(v=>v==='mcp-server'?'sync':v),
    server.argv.map(v=>v===caveat?caveat.replace('0.21.5','0.21.6'):v),
    server.argv.map(v=>v==='--disable-warning=ExperimentalWarning'?'--inspect':v)]) {
    assert.equal(trusted([root,{...server,argv}]), false)
  }
  assert.equal(trusted([root,{...server,ppid:99}]),false)
})

test('Caveat extra child remains work, and existing unknown direct MCP stays untrusted', () => {
  const work={pid:30,ppid:20,pgid:10,start:'120',state:'S',exe:'/usr/bin/python3',argv:null}
  assert.equal(trusted([root,server,work]),false)
  assert.equal(trusted([root,{...server,argv:[node,'/other/server.mjs']}]),false)
})
