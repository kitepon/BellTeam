# Webの保存と回収

所有アドミ。全体は[機能図](../../feature-map.md)と[データフロー](../../data-flow.md)、接続は[Web](README.md)と[共通HTTP](../integration/README.md)。Webはブラウザー状態と静的sourceを持ち、サーバーの会話原本・画像・正式資材やbackupを複製保存しない。

## 機能・保存の所有

| 機能 | 所有する保存物 | 回収と失敗 |
| --- | --- | --- |
| applicationの既読 | localStorageの`bellteam-read-receipts.v1`だけ | 最新の完全一覧GET成功後、現存Bot/Room key以外を削除して同keyへ保存。失敗/旧応答で削除しない。保存不可は既契約どおり例外を画面へ出さない |
| composer | 会話別の未送信/送信snapshot・添付URL | 受付・利用者の破棄・添付削除時に解放。送信失敗/結果不明/削除中の入力は保持 |
| 履歴画像/設定画 | ページ内の取得Promise/所有Blob URL | 複数画像の途中失敗も完了を集めて回収。設定画close/reopen、画像cacheの非BFCache pagehideで解放。viewerは所有URLを破棄しない |
| export | 利用者が要求したBlob URL | download後revoke、利用者が保存したファイルは利用者所有 |
| 更新結果 | sessionStorageの同UUID/planとprevious | unknownの耐久追跡を維持。容量整理で消さない |
| 通知SW | 検証済みpush表示とクリック先 | CacheStorage/IndexedDB/資材複製なし。登録寿命はusageの正本 |
| build/配置 | `web/assets.mjs`の静的登録/source | archive/OCI/partial/stageは配布、readerと選択保持はruntimeが所有。Webで別copyやbackupを作らない |

## データフロー

`HTTP bots/rooms/owner全件成功→catalogueRead一致→Bot/Roomの現在key集合→既読の非現存keyを除去→localStorage同key→既一覧描画`。一覧の失敗と古い応答はこの回収へ進めない。現存keyの値は変更せず、下書き・添付・unknown更新・他storage keyは入力にも出力にも含めない。

`画像HTTP/File→所有者がBlob URL生成→履歴/下書き/viewerが参照→受付/破棄/close/非BFCache pagehide→生成者がrevoke`。途中失敗は生成済みURLを回収し、未送信入力の唯一データは保持する。

静的登録と公開HTTP/保存schemaの変更は無い。全体接続線とmodule.jsonは不変。直接検証は`test/web-module.test.mjs`のapplication/人工公開GETを使い、サーバー内部群を追加条件にしない。
