import {execFile} from 'node:child_process'
import {promisify} from 'node:util'
import test from 'node:test'
const exec=promisify(execFile)
test('QNAP復旧点はimage重複排除・全読戻し・失敗停止を保つ',async()=>{
 await exec('python3',['-m','unittest','discover','-s','test','-p','deploy_restore_test.py'])
})
