#!/usr/bin/env node
// 取得確認用。候補の正本は実行環境のCLIであり、保存した一覧は画面へ配信しない。
import { LiveModelCatalog } from '../src/model-catalog.mjs'
const models = await new LiveModelCatalog().list(process.argv[2])
console.log(JSON.stringify({ models }, null, 2))
if (Object.values(models).some(entry => entry.error)) process.exitCode = 1
