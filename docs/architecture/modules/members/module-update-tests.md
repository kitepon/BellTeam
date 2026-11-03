# 独立更新の境界試験計画

[契約入力](module-update.md)の実装準備。基準9e83、初回設計作者90ebd456。以下は未実装の試験計画であり、成功実績ではない。公開DTO・期限・権限伝達はRoot裁定を反映してから試験を実装する。

## 既試験を生かす範囲

| 現source / 既test | 保持する観測 | 分離時の追加 |
| --- | --- | --- |
| bot-registry / bot-registry.test | seed、profile/session再読込、model/fast検証、指示生成 | read-only attachの書込み0と破損拒否 |
| schedule-mutations / schedule-generation.test | owner直列化、同ID編集、削除後復活0、失敗後lock解放 | 発行前claimへfixture停止位置を移す。旧dispatch後markの順番自体はassertしない |
| members/deletion / member-deletion.test | pending再開、stop不要、cleanupとCLI同期の別失敗 | 対象画像writer終端前rename0、背景削除のdrain追跡 |
| project-files / bot-registry.test | previous-sessionから個別指示 | 純粋生成と固定内容writerで本文bytes・順序・部分失敗を保持 |
| global-instructions / global-instructions.test | 全CLIで同じ規範 | child生成と親writerの一致、保存後生成失敗の正本残存 |
| mcp-owner-tools / mcp-owner-tools.test | 全文更新と再生成 | 専用登録経路のみ更新可、通常MCPから更新0 |

## members内部fixture

実ファイルの隔離root、固定clock/IDとdeferred Promiseを使う。sleepや実Botを使わず保存・依存操作を入口/終端で止める。人工adapterの成功を実物受入とは呼ばない。

1. **読取restore**：bootstrap済みbot.v8/schedule.v1/receipt/`.initialized`のbytesを採取。attach後も同bytes、runtime/model/CLI/配送のspyは0。activeだけ実行対象、pendingは一覧。未初期化・破損・非対応schemaを空台帳へ置換せずready失敗。mtimeだけで無書込みを判定しない。
2. **profile/session**：同Botのprofile保存を保留→session更新投入→解放。再読込で両field保持。別Botは進行可能、依存writer失敗後も次操作が終端する。
3. **Bot claim**：同tuple二要求→成功snapshot一つ/もう一つnull、保存消化一回。古revision/nextRunAt・disabled・未到来・不正ranAtは発行0。全4種類の次回計算は既normalizeを使い、発行でrevision増加0。
4. **編集交差**：list後の同内容再設定でも新revisionを保持。claim後編集は新予定を残す。削除・Bot退役後に古claimや空予定読取がdirectoryを再作成しない。退役との直列化を同じwriterで確認。
5. **切断点**：claim保存失敗、保存完了後応答喪失、claim返却後/発行前、親発行後/結果前で停止。保存失敗/応答不明は発行0、発行済みunknownは再送0。次tick/再attachで消化済み回を復元発行しない。未配送許容はRoot固定方針に従う。
6. **停止/手動**：claim前pausedは保存0/発行0。claim後停止世代変更は発行0。prepareResumeは対象時刻以下だけskip、lastRunAtと新revisionを保持。手動runはnextRunAt/enabledを変えない。
7. **drain**：新rootはnot_accepted、旧要求のeffect結果/session保存は通す。背景削除も追跡し、未終端ならquiesced0。期限超過→旧resume/次writer0。送信後断線はunknown/再送0。
8. **生成**：空/日本語/改行付き短期記憶、未設定profile、長文のbytesを現版と照合。previous保存成功→指示失敗でもprevious保持。Owner保存成功→global失敗でも正本保持、成功へ丸めない。

## 他担当との結合で証明すること

| 担当 / 接点 | 停止位置 | 必要な観測 |
| --- | --- | --- |
| N102 / Room claimDue・skipDue | list後targets整理、同tuple二要求、保存応答喪失 | 最新snapshotだけ発行、null/不明は0。同じRoomRegistry実体を使用し、第二実体で排他を証明しない |
| N102 / asset removal | readImage受付後・write前 | 対象owner新save拒否、旧write終端後rename。他Bot/user保存継続。pending/不明からcancelしない |
| Kiro / epoch-token | prepare前、native後/session保存前、idle待ち | 保存終端までtoken、idle待ち後旧epochは発行0。既command/出力/watch/STOP継続 |
| Epi / 固定effect・席writer | effect送信後、席stdio/CLI queue未終端 | quiesced早返し0、任意path/home/env/method拒否。UID1000入口も閉集合検証 |
| Molly / facade・owner proxy | snapshot途中断線、新認証時子不在 | 不完全投影を最新へ昇格0。未供給503と404/400を区別。owner自己申告で権限0 |
| Epi/Centi / controller・固定entry | 旧lock保持、ready失敗、現state旧版戻し | 同時writer0、旧OS/stdio終端、state巻戻し0。同source builtin→署名版→builtinの実物原本 |

members担当は自身のfixture/assertを実装し、相手の公開adapterで結合する。他担当内部を変更しない。実AI同session/launch/turn・出力保存、正規UID/OS排他と配布受入は各担当の直接原本を別に受領する。

## 実装差分の順序案

read-only restoreと純粋本文生成を内部で分け、bootstrapと既出力を維持する。次に固定dispatcher/facadeと親effect/受付/drainを結合する。予定claimはRoom唯一writer/停止世代の公開契約供給後にBot側と発行loopを合わせる。最後に既handler/schema/返却を共通組立へ接続し、同source交換の配布受入へ進む。未固定契約を先行実装する許可ではない。

基準試験33pass/0fail/0skip。原本は作者席 `integrations/members-module-update-20261103/preimplementation-tests.log`。新交換契約・実AI・配布・本番は未検証。
