import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'

// A file the public package ships but the push filter omits merges without producing a body image.
test('server image push paths cover every path the public package archives', async () => {
  const source = await readFile(new URL('../scripts/package-server.mjs', import.meta.url), 'utf8')
  const start = source.indexOf("'archive'"), end = source.indexOf('{ cwd: root }', start)
  const archived = [...source.slice(start, end).matchAll(/'([^']+)'/g)].map(m => m[1]).filter(p => !['archive', '--format=tar', '-o'].includes(p))
  const workflow = await readFile(new URL('../.github/workflows/publish-server-image.yml', import.meta.url), 'utf8')
  const paths = [...workflow.slice(0, workflow.indexOf('concurrency')).matchAll(/^ {6}- (\S+)$/gm)].map(m => m[1])
  assert.ok(archived.length > 40 && paths.length > 40)
  const covered = p => paths.some(q => q.endsWith('/**') ? p === q.slice(0, -3) || p.startsWith(q.slice(0, -2)) : p === q)
  assert.deepEqual(archived.filter(p => !covered(p)), [])
})
