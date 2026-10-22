# Appleアプリ高速化の継続作業

## 完了条件

- iPhone・iPad・Macで会話、入力、Bot画面、予定の無関係な更新処理を減らし、表示内容・読み位置・日本語入力・接続復旧を保つ。
- サーバーが所有する履歴・カード・room定義・画面照会・SSEの修理を、Apple受信処理と同じ応答契約で照合する。
- focused testと必要な最終gateを通し、GitHub main、内部TestFlight、サーバー本番の正規反映と導入後確認まで届ける。本番コンテナの再作成は個別許可後だけ行う。
- 出力件数に比例して不可避な計算と、未解消の負荷は根拠付きで開示する。

## Apple側の現在地

- `apple-performance-59`でBot画面の同値本文再描画を止め、会話の配置を画面と上下2画面分へ絞った。人工100行で更新中の操作を確認し、iPhone/iPadの過去取得・読書位置・カード状態も対象試験で確認した。Mac Catalystの共通コードはビルドできた。MacのUI自動試験は開発用署名profile不足で未実施とし、配布後の実アプリを確認する。
- 会話を`LazyVStack`へ単純に替えると、人工10行の更新でもメインスレッドが高CPUのまま試験が進まない。末尾の標準anchorを外しても`scrollTo`、標準`scrollPosition`のいずれかを戻すと再現した。末尾表示を両方外すと操作試験は通るが、既存の画面契約を満たさない。実験変更は正規コードから外した。CPU標本の原本は`runtime/apple/performance-59/lazy-vstack-freeze.sample.txt.gz`に置いた。
- SSEは既存の`event: messages`と`at`を保ち、`all`・`topics`・`botIds`・`roomIds`を加算する契約でサーバー担当と調整した。`schedules`もtopicに含める。旧形式・不正・未知topicは全体照合、初回と再接続時の`ready`も全体照合とする。
- 宛先が確かな通知は該当会話へ直接届け、Bot/room/queue/ownerのうち必要な一覧だけを取得する。予定タブも通知が示すBot/roomだけを取得する。実サーバーを人工データで起動した結合画面試験は2件成功し、初回・再接続・旧形式・不正scope・未知topic・全体通知・壊れたJSONの停止まで確認した。試験の原本と残る計算は[結合記録](evidence/2026-10-23-apple-server-performance-59.md)に置いた。

## 残る作業

1. サーバー本番反映は、別個のコンテナ再作成許可を得て正規`deploy.sh`で行い、公開後に対象通知と既存APIを確認する。
2. iPhone版59の実機での操作感と電池消費は、内部TestFlightからオーナー本人が確認する。MacはTestFlightから59を導入し、起動・会話スクロール・入力と消去まで確認済み。

実Botの設定・削除、未知POSTの再送、本人の操作中アプリの終了は性能試験に含めない。
