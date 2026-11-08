# Appleアプリとの接点

担当：ベル。Apple各画面と配布。

Apple内部の機能図は未作成（担当ベルの2026-11-02回答）。現在の資料は[iOS README](../../../../ios/BellBot/README.md)と[iPad設計](../../../ipad-app.md)、実装はios/BellBot。次のコード変更前に該当範囲の図を製品担当が整える。内部図が揃ったとはしない。

範囲図：[予定一覧の取得](schedule-list.md)、[メンバー画像の保存と表示の更新](avatar-save-display.md)、[一覧の再取得の赤字](list-refresh-error.md)、[通信失敗の診断で残す経路の型](diagnostic-routes.md)。

本体への提供窓口はなく、利用側としてHTTP /api/*とSSE /api/eventsを使う。MCP利用はない。会話はN102、設定/通知はミカ、モデル操作はキロ、更新実行はエピネルへ、共通HTTP/SSEの実装はモリーへ接続する。ベルはlocalチームのためBellTeam botIdを持たず、連絡はトロニーの既call-bridge通話から中継する。

商用更新は[Webとの共通状態設計](../web/update-notice-design.md)へ接続し、Update画面・SSE updates・push kind=updateは[Update画面](update.md)で実装済み。ロゴ右を置けない画面の通知帯は未採用の代替案で、Ownerの配置指示を変更したことにしない。

[接続情報](module.json) / [共通の変更手順](../../module-ownership.md)

## Apple内部の調査図への索引

上の「未作成」は従来の記録として保ち、固定HEAD `4e01fadcb5edcaa74c010436a47be9cb26eabeec` の実装調査を以下へ追加する。調査範囲・未調査は各文書の末尾を参照。

- [全体機能図と本体への公開接点](overview.md)：入口、platform配置、会話、設定、認証、通知、購読、端末保存、診断、試験とpack構成。
- [状態の所有とHTTP・SSE同期](state-and-sync.md)：Models/AppStore/BellAPI、受付・処理結果・画面反映、失敗・取消・後始末。
- [一覧・検索とメンバー・ルーム編集](members-and-rooms.md)：行の素材、検索語、draft、参加者/代表、保存と削除。
- [設定・Ownerプロフィール・メンバー画像](settings-and-profile.md)：Owner/規範、追加機能、AI停止カード、画像選択・確認・取消。
- [ファイル・型・関数と試験の索引](function-index.md)：実装への行リンク、試験の対応、全文読了と本文未読の目録。
- [予定一覧の取得](schedule-list.md)：既存範囲図をそのまま再利用する。
- [会話](conversation.md)：履歴の取得、下書き、添付、送信と配送表示、ルーム宛先、画像、停止と再起動、端末画面、書き出し。
- [質問・秘密入力・接続認証](requests-and-auth.md)：質問と選択回答、秘密入力、ログイン、初回利用、AI再認証。
- [goal](goals.md)：goal一覧、会話内goal、操作。
- [相関図](work-graph.md)：作業中のメンバーと依頼の流れのネイティブ描画（iPhone/iPadはタブ、Macは別窓）。
- [背景復帰・通知・購読・platform配置](lifecycle-and-platform.md)：SSE再接続と背景復帰、push拡張、購読と復元、端末保存とlogout、iPhone・iPad・Macの差。
- [試験の対応表](tests.md)：XCTestと独立チェックの本文から、各試験が確かめる契約。
- [Update画面](update.md)：商用更新の表示、計画と実行、結果照会、SSE `updates`、push `kind=update`。
- [責務整理の設計](refactor-design.md)：整理候補の採否、比較、全caller・試験、PRの順番。

## 整理候補

今回の調査で記録した7件の所在は[索引](function-index.md#整理候補)を参照。

## 未調査

各図の未調査事項と[Swift読取目録](function-index.md#読取範囲と本文未読のswiftファイル)を参照。本体内部と実行検証は今回の調査に含めない。
