import assert from 'node:assert/strict'
import {readFile} from 'node:fs/promises'
import test from 'node:test'
test('正規adapterは共通installerへ接続し、quiet待ちや毎回archiveを復活させない',async()=>{
 const source=await readFile(new URL('../scripts/deploy-image.sh',import.meta.url),'utf8')
 assert.match(source,/sh distribution\/server\/install.sh --no-pull/)
 assert.doesNotMatch(source,/check-deploy-quiet|save-deploy-restore-point/)
 assert.doesNotMatch(source,/save_archive|mktemp -d runtime\/backups|image-before-deploy/)
})
