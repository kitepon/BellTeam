# Mac版の審査への追加返信

Mac版の審査メッセージを読み戻し、前回の9項目の回答が全文保存されていることと、Appleから追加返信が無いことを確認した。iOS版の公開、同じアプリ登録・Bundle IDのプラットフォーム版であること、Mac向けの画面と操作を補足し、審査継続と必要な追加資料の具体的な指示を依頼した。

追加返信は[返信本文](../app-review-mac-follow-up.md)に保存した。入力欄の値と全文一致を確認してから送信し、Apple側のメッセージが増えたことを確認した。ページを再読み込みし、保存された本文が返信本文と全文一致することを再確認した。時刻、文字数、審査状態、提出IDと証拠の場所は[準備状況の正本](../subscription-setup.json)の`integration.reviewSubmission.rejectionResponse.macFollowUp`に記録する。

Appleの元の通知は、アプリが規定を満たすと考える場合、再提出せず9項目へ返信するよう求めていた。今回はその提出を保持し、追加の情報をメッセージで届けた。審査対象のビルドは変更していない。確認時点でMac版は未解決の問題が残る状態であり、承認済みとは扱わない。iOS版は配信可能で、審査提出は完了していた。

## 操作と検証

Jev Bookmarksは認証が切れた専用Chromeのログイン画面を選び、本文の読み取りまで進まなかった。Jevのブラウザ接続も、Chromeの接続承認が終わる前に接続が終了するエラーで失敗した。この2つの失敗を審査確認の成功には数えない。

既にASCへログインしていた通常のChromeをJevデスクトップで操作した。Mac版の提出ページを直接開き、Appleの通知と前回の回答を照合した。返信ボタンの操作で審査一覧へ戻る誤選択があり、Mac版の提出ページへ戻って、正しい返信ボタンから入力欄を開いた。新しい返信の入力欄と送信ボタンはJevで特定した。

操作ツールのクリップボード読み取りは、`ACTION_NOT_SUPPORTED`、`The packaged macOS clipboard helper is missing or invalid`、`No colocated packaged helper was found`で失敗した。失敗を開示し、この作業ではMac標準の`pbpaste`で選択した審査本文を読む一時的な手順を使用した。入力前後の値と保存本文の一致を確認したが、補助プログラムの不足は未修理である。認証情報を本文や記録へ複製していない。

操作とコピーした全文はGit管理外の証拠ディレクトリへ保存した。公開する記録は、送信内容と検証結果に限る。

## Appleの一次資料

[App Reviewのメッセージへの返信](https://developer.apple.com/help/app-store-connect/manage-submissions-to-app-review/reply-to-app-review-messages)は、拒絶についてメッセージと資料で説明できること、返信の入力と送信の手順を案内している。[審査ガイドライン](https://developer.apple.com/app-store/review/guidelines/)の4.3は重複・独自性、4.2.6はテンプレートや生成サービスと内容提供者による提出を扱う。今回の補足は、前回の回答と同じ製品の事実を示すものであり、Appleの承認を保証するものではない。
