# 実行環境のモデル一覧を動的に取得する

取得日: 2026-10-03。出典: BellTeamのソースと本番コンテナ内のAiterm `agent_models`。確度: 実測済み。

モデル欄は同梱した `config/models.json` を読み、CLI更新後も候補を更新しなかった。本番CodexにはGPT-6.1 Solがある一方、BellTeamのAPIには無い状態を確認した。

Aitermには4ハーネスの公式一覧を取得する公開APIがある。Claudeはstream-jsonのinitialize、CodexはApp Serverのmodel/list、Grokはagent stdioのinitialize、Cursorはmodelsを読み、渡せるIDとモデル別のエフォートを返す。Peertableも席変更時にCLIの一覧を読む処理を持つが、BellTeamの取得にはAitermを使う。

BellTeamのAPIは要求ごとにAitermから取得する。各CLIに短命のMCP接続を使い、配送用の接続で一覧取得を待たせない。Webは起動・会話更新から取得を外し、メンバー編集を開く時に読み直す。Appleアプリも同じAPIを使う。MCPのlist_modelsも内部の同じAPIを呼ぶ。保存時のエフォート確認は指定CLIの最新の一覧を読み、保存済みプロフィールの読込とAI設定を変えない編集は一覧を要求しない。

固定一覧での代用・保存・自動再試行は行わない。取得失敗はCLIごとの理由を返し、WebとAppleアプリへ表示する。配布archiveから旧候補ファイルを除いた。

## 検証

- 変更に直結する62試験と、完了時の全331試験が成功した。
- 本番と同じコンテナ内で、変更したHTTP APIを別の一時ポートへ起動した。既存サーバーを停止・再起動せず、共有設定を書き換えずに確認した。
- 4ハーネスの取得は約3022msで成功した。Claude 12件、Codex 9件、Grok 4件、Cursor 47件を返し、CodexにはGPT-6.1 Solがあった。この件数は確認時の記録であり、現行候補の正本ではない。
- 一覧取得中もhealthzは200。個別CLI取得は指定したCLIだけを返し、未知のCLI指定は400。
- ローカルのサーバー用HOMEでの試行ではCodexプロセスが起動に失敗し、固定候補に切り替えずMODEL_CATALOG_UNAVAILABLEを表示した。成功確認は本番と同じ実行環境で行った。

## 公開後の結果

オーナーがApproval Box K-3CMF2Wで本番反映を許可した。稼働中の18メンバーを記録し、scripts/deploy.shで反映した。本番のhealthzは正常、反映前の26メンバー全員が保持された。本番APIも4ハーネスの一覧とGPT-6.1 Solを返した。18メンバー全員へ再開を伝えてHTTP 200の受付を確認し、その後も全員のCLIがオンラインであることを確認した。

AppleアプリはiPhone・Macのビルド33を署名・書き出し・アップロードした。AppleのVALID、Ownerグループへの登録、IN_BETA_TESTINGを両プラットフォームで確認した。このMacにも標準のinstall-mac.shで導入し、起動を確認した。審査待ちのアプリは変更していない。

配布CIは、最初に未認証のCursorまで成功するという試験の誤った前提で失敗した。空のHOMEでCursorがAuthentication requiredを返すことを再現し、その認証エラーと他3種の正常取得を検査する試験へ直した。認証済み4種の正常取得は本番環境で別に確認した。修正後の両CPUのCIとイメージ登録は成功した。公開registryのmanifestも匿名でHTTP 200となり、amd64・arm64を含むことを確認した。

Macの実画面はagent-desktopで記録した。Jev Desktopによる候補メニューの操作は、対象の識別で停止した。モデル候補メニュー内の目視確認は未完了であり、APIの取得成功・アプリのビルドと配布の確認とは区別する。

記録はruntime/apple/live-models-33/のproduction-proof.json、resume-proof.json、resume-online-proof.json、testflight-33-proof.jsonと、GitHub Actions run 37116396418に残した。
