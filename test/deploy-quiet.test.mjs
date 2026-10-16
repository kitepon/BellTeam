import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { chmod, copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import test from 'node:test'

const exec = promisify(execFile)
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
