# iPhoneのメンバー削除（2026-10-20）

オーナーが作成済みメンバーをiPhoneから削除できないと指摘した。Appleアプリの`BotEditor`には削除入口がなく、`AppStore`にも既存の`DELETE /api/bots/:id`への接続がなかった。トロニーはサーバーの削除隔離試験を1件成功と報告した。DELETEは202を返した後、セッション停止、ルーム参照の除去、メンバーのプロジェクト削除を非同期に行う。サーバーのコードは今回変更していない。トロニーの証拠は担当席の`integrations/iphone-member-delete-20261020/backend-delete-test.log`。

アプリ修理commit `36d48a9`で共通のメンバー編集画面に削除確認を追加した。確認文は会話・予定・記憶を含むプロジェクトとルーム参照が消えることを明記する。202後は受付中と表示して再送を防ぎ、成功した一覧取得で対象が消えた時だけ選択中の会話と下書きを片付ける。応答断など結果未確認の失敗は、再操作前の一覧確認を案内する。iPhoneの本番メンバーへのDELETEは送っていない。

iPhone Simulatorの新しい対象試験は、202後の保持・一覧消失後の整理、HTTP 503と応答断での保持、確認画面の範囲・取消・未接続表示を確認した。関連する前景更新とルーム削除を含む8件が成功した後、応答断の追加修正に対する対象4件が成功した。Mac Catalystのアプリ本体ビルドは成功。`TESTGATE_FULL=1 npm test`は終了コード0。既存の`WKWebsiteDataStore.default()`のactor警告は残り、今回の修理経路で発生したエラーではない。

ASCではiOSの1.0.1（52）が既に公開され、1.0.1（53）は内部TestFlightにある。最初の1.0.1（54）のApple事前検証は90062・90186で拒否された。公開済み1.0.1のpre-release trainが閉じていたためで、Appleへは送信していない。[Appleのビルド登録の説明](https://developer.apple.com/help/app-store-connect/manage-builds/upload-builds)に従い、版を1.0.2へ上げたcommit `00af686`からiPhoneアプリと通知拡張の54を作り直した。

1.0.2（54）のiPhone archive・IPAは`runtime/apple/member-deletion-54/`に置いた。IPAのSHA-256は`4e906cdb07d7ac142a3eb964dd0dcf9b56435d7730a54557e7f601bfe7a66659`。展開した本体・通知拡張の版を確認し、両署名の`codesign --verify --strict`が成功。Apple公式`altool`事前検証も`No errors validating archive`。

決裁箱「iPhoneメンバー削除版1.0.2（54）を内部TestFlightへ送信してよい？」（`K-S2U4S9`）のGOを受け、同じIPAの検査値とsource commitのmain祖先を再確認し、Appleへ一度だけ送信した。Appleのbuild `c09c145c-aeca-452c-bc05-42b729da8b49`は`VALID`、オーナー用内部グループへ追加した後の`internalBuildState`は`IN_BETA_TESTING`。一般公開審査の提出と本番コンテナの更新は行っていない。iPhone端末での導入・起動、実際のメンバー削除は未確認。
