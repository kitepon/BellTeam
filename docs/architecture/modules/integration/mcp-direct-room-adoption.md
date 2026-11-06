# 既親MCPの不要Room取得だけを同参照へ採用する

Rootの初回421d transport7methodとは独立の次単位。Mollyは共通MCPの最小policy/生参照を所有、Epiは標準Inspector初回到達/UUID耐久作用、Rootが具体actor/作用を別に固定する。新親receiver全体を要求しない。

| 機能 | 入出力・保持 | 失敗 |
| --- | --- | --- |
| 固定参照取得 | 同PID・Root固定portの既HTTPServer.notify→createMessageEventsの既知closure一つ→rooms object参照だけ | Server一意でない/既scopeなし/roomsなしは変更0。変数書換え/heap query/他scope・subscriber・settings・本文の展開0 |
| cached SDK参照 | 元ESM SDK Server.prototype.setRequestHandlerと同rooms.refreshの元指紋 | CJS別class/未知hash/descriptor不可は変更0。新品Serverや別roomsを元実体へ付替えない |
| applyMcpDirectRoomBypass | 元2descriptorを保持、直接2tool markerのAsyncLocalStorage一実体→SDK handler登録とrooms.refreshの2descriptorだけ同期採用 | 同turnで後半失敗なら元SDKdescriptorへ戻す。元controller/actor/認証/本人/引数/宛先/添付/handlerは維持 |
| 新MCP POST | 既createSeatMcpが毎POST Serverを生成→元SDK validator→同handlerを実行scopeで囲む | sendmessage/send_user_messageだけ同rooms.refreshを省略。他tool/Roomは元refresh/拒否 |
| 旧実行 | 既登録handler/旧Promise/native/job/Map/callbackを元ownerのまま続ける | 旧本文再送・旧unknown解除・既処理強制再開0。修理前に登録済みのrequestを無断で再実行しない |

DFD: `Root固定Node/port→既HTTPServer.notify→既知createMessageEvents scope descriptor（raw保存0/内部値展開0）→同rooms参照→元2指紋照合→同一turnでSDK登録wrapper+rooms.refresh wrapper`。通常実行は `新MCP POST→元seat認証/actor/SDK validator→tool名2種だけ独立ALS marker→元callBellTeamTool→fresh registry/本人/閉引数→Roomだけ省略→元target/添付/既配送`。他toolは同元Roomrefreshを実行する。ALSは要求間で混ざらず、既actorのALSを置換しない。

既ESMのrunBellTeamTool lexical bindingはexport再importだけでは替わらない。setScriptSourceは自席Node26.13で機能廃止エラーとなったため使用しない。固定参照の一scope照合にRuntime.getPropertiesを使うが、一般heap探索/任意scope探索/Debugger pause/source edit/secret値展開は行わない。短命client/intent/receiptの正式接続はEpiと閉じてからRootへ渡す。新7method sidecarの仕様へ無断追加せず、初回署名を待たせない。

自席有限検証は実421dのcreateBellTeamServer/createMessageEvents/createConversationFacade/callBellTeamToolと元cached ESM SDKを使い、標準Inspectorから同rooms参照へ到達して2descriptorを採用する。一回のfixtureで直接2tool、その他Room拒否、欠sender、既actor/Promise保持、元hash不一致の変更0を確認する。実本番を読み取らず、結果は現用適用成功の証明ではない。
