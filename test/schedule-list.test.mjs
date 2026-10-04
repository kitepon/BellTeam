import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import vm from 'node:vm'
import test from 'node:test'

const app = await readFile(new URL('../web/app.js', import.meta.url), 'utf8')
const source = app.slice(app.indexOf('async function loadSchedules()'), app.indexOf('\nfunction renderScheduleTargets()'))

async function render(schedules) {
  const list = { innerHTML: '', rows: [], replaceChildren(...rows) { this.rows = rows } }
  const context = vm.createContext({
    api: async () => ({ schedules }), schedulePath: () => '/schedules', scheduleList: list,
    document: { createElement: () => ({ querySelector: () => ({ addEventListener() {} }) }) },
    escapeHtml: value => value ?? '', scheduleDescription: () => '', formatDateTime: () => '',
  })
  await vm.runInContext(`${source}\nloadSchedules()`, context)
  return list
}

test('保存済みの実行済み単発予定を除き、繰り返し・未実行・停止中の予定を表示する', async () => {
  const completed = { kind: 'once', enabled: false, lastRunAt: '2026-09-06T06:20:00Z', nextRunAt: null }
  const schedules = [
    { ...completed, name: '実行済み' },
    { ...completed, kind: 'cron', name: '繰り返し' },
    { kind: 'once', enabled: true, at: '2026-09-01T00:00:00Z', lastRunAt: null, name: '期限超過の未実行' },
    { kind: 'once', enabled: false, lastRunAt: null, name: '停止中' },
    { ...completed, enabled: true, nextRunAt: '2026-09-07T00:00:00Z', name: '再設定済み' },
  ]
  const list = await render(schedules)
  assert.equal(list.rows.length, 4)
  assert.deepEqual(list.rows.map(row => row.innerHTML.match(/<strong>(.*?)<\/strong>/u)[1]),
    ['繰り返し', '期限超過の未実行', '停止中', '再設定済み'])
  assert.equal(schedules.length, 5)
})

test('実行済み単発予定だけの一覧は空状態を表示する', async () => {
  const list = await render([{ kind: 'once', enabled: false, lastRunAt: '2026-09-06T06:20:00Z', nextRunAt: null }])
  assert.equal(list.rows.length, 0)
  assert.match(list.innerHTML, /予定はありません。/u)
})
