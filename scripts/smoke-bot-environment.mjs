// 専用の永続フォルダをマウントした使い捨てコンテナで実行する。本番Botは使わない。
// 同じフォルダを別の新規コンテナへ再マウントし、もう一度実行すると更新後の復元も確認できる。
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { promisify } from 'node:util'

import { restoreBotEnvironments } from '../src/bot-environment.mjs'
import { runShellCommand } from '../src/scheduler.mjs'

const exec = promisify(execFile)
const project = '/srv/bellteam/bots/bot-environment-smoke'
await exec('sudo', ['-n', 'true'])
await assert.rejects(exec('sh', ['-c', 'command -v tree']), '新規コンテナでは追加したOSパッケージはまだ無い')
await mkdir(`${project}/environment`, { recursive: true })
let pass = 0
try { pass = Number(await readFile(`${project}/pass`, 'utf8')) } catch (error) { if (error.code !== 'ENOENT') throw error }
if (pass === 0) {
  await writeFile(`${project}/environment/requirements.txt`, 'packaging==24.2\n')
  await writeFile(`${project}/environment/setup.sh`, `set -eu
sudo apt-get update
sudo apt-get install -y tree
/usr/bin/python3 -m venv --clear environment/python
environment/python/bin/python -m pip install -r environment/requirements.txt
npm install -g semver@7.7.2
`)
  await writeFile(`${project}/environment/env.sh`, 'export PATH="$BELLTEAM_PROJECT/environment/python/bin:$PATH"\nexport SMOKE_VALUE="value with spaces"\n')
} else {
  // 永続していたvenv自体が使えなくなっても、依存ファイルから復元できる。
  await rm(`${project}/environment/python`, { recursive: true, force: true })
}
const results = await restoreBotEnvironments(new Map([['bot-environment-smoke', { id: 'bot-environment-smoke', project }]]))
assert.equal(results[0].code, 0, await readFile(`${project}/environment/setup.log`, 'utf8'))
const result = await runShellCommand({ cwd: project, command: `set -e
test "$(id -u)" = 1000
test "$SMOKE_VALUE" = "value with spaces"
tree --version
python -c 'import packaging; assert packaging.__version__ == "24.2"; print("python-package-ok")'
test "$(semver 1.2.3)" = 1.2.3
test "$(npm config get prefix)" = "$BELLTEAM_PROJECT/.local"
printf 'node-cli-ok\\n'
` })
assert.equal(result.code, 0, result.stderr)
await writeFile(`${project}/pass`, String(pass + 1))
console.log(JSON.stringify({ pass: pass + 1, sudo: true, restored: true, commandEnvironment: true, output: result.stdout.trim() }))
