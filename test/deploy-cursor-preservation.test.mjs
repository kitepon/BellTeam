import assert from 'node:assert/strict'
import {readFile} from 'node:fs/promises'
import test from 'node:test'
test('正規adapterはNAS復旧点が成功するまでpullとupを始めずrootへtarを作らない',async()=>{
 const source=await readFile(new URL('../scripts/deploy-image.sh',import.meta.url),'utf8')
 assert.ok(source.indexOf('previous=$(python3 scripts/save-deploy-restore-point.py)')<source.indexOf('docker compose pull'))
 assert.doesNotMatch(source,/save_archive|mktemp -d runtime\/backups|image-before-deploy/)
})
