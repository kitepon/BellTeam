# 共通JSON保存の一時file寿命

所有モリー。各moduleは保存値・path・採用/失敗判定を所有し、共通`src/json-file.mjs`は一回の一時fileとrenameを所有する。[integration](README.md)、[全体機能図](../../feature-map.md)、[全体DFD](../../data-flow.md)から接続する。

## 機能と所有

| 機能 | 入力→出力・所有 | 失敗と回収 |
| --- | --- | --- |
| `writeAtomic(path,value)` | callerのpath/value→既JSON整形と末尾改行→同pathのUUID.tmpを0600で書込→rename | serialize/write/rename失敗時に同callのtmpだけunlinkを試み、元error objectをそのまま拒否。unlink失敗で元errorを隠さない |
| 既保存caller | BotRegistry（再export含む）/RoomRegistry、OwnerProfile、harness config、各module process採用、診断、usage背景設定、共通OLRW preflight | 値/schema/認可/排他/失敗分類/保存ACKは各writerに残る。targetや他callのtmpを回収しない |
| 固定資材 | 親imageと既module archiveのsource収録 | 親適用を旧selected archiveの差替えへ補完しない。親の通常供給と各moduleの必要source供給を区別する |

## データフロー

`保存caller(path,value)→JSON整形→path.UUID.tmp(writeFile/0600)→rename(path)→既成功返却`。

`JSON整形/writeFile/rename拒否→同call UUID.tmpのunlink試行→元例外をcallerへ返却`。cleanupの成功/失敗は元例外を変えず、旧target/他file/unknown操作記録へは接続しない。write完了後rename拒否ならtemp bytesを回収し、書込拒否でtmp不在ならunlinkのENOENTも元エラーに置換しない。

fsync、保存順/形式、権限の昇格、API/互換/reader、既ACKの意味は変更しない。強制終了やunlink自体の拒否で残るtmpをこの修理で回収済みとしない。必要な直接確認は`test/json-file.test.mjs`の実FS3caseだけ。
