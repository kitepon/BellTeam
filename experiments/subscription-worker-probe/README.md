# 購読確認WorkerのCPU試験

Workers Freeの10 ms CPU上限で実行できるか調べる一時的な試作品。鍵は公開試験用であり、Appleの鍵・購入情報・BellTeamの会話は扱わない。`/probe`は基礎暗号処理だけ、`/apple-*-probe`は証明書チェーンの検証も行う。Apple APIへの実通信は含まないため、実製品のCPU使用量を確定する試験ではない。

```sh
npm exec --yes --package wrangler@latest -- wrangler dev
```

`GET /probe`が`{"verified":true,"signatureBytes":64}`を返すことを確認する。公開して測る場合は、同じディレクトリから`wrangler deploy`を行い、CloudflareのWorker別CPU時間と超過エラーを確認する。`report.json`へ記録した数値は`GET /`の公開レポートと`GET /report.json`へ表示される。

CloudflareのGraphQLの`cpuTimeP50`等はマイクロ秒で返る。公開レポートはミリ秒へ変換した値を使う。公開Workerの`performance.now()`はI/Oまで進まないため、CPU時間の計測には使わない。

ネイティブ検証器の集計では、ミリ秒を含む開始・終了時刻の指定で空の集計が返った。秒単位へ外向きにそろえた半開区間では100回の集計が得られた。実際の測定時刻と集計期間は両方を記録し、件数の一致を確認する。

## Apple公式ライブラリの試験

`GET /apple-library-probe`では、Apple公式のApp Store Server LibraryでAPI用JWTの署名を1回、証明書チェーンを含む取引・更新情報の検証を3回行う。提出された取引・Apple APIから得る最新取引・更新情報の順に相当する。HTTP通信には試験応答を使い、Apple APIの実通信と証明書のオンライン失効確認は含めない。

証明書・署名データ・秘密鍵は[Apple公式の公開試験データ](https://github.com/apple/app-store-server-library-node/tree/main/tests/resources)だけを使う。`apple-test-fixtures.json`にまとめ、ライセンスを`APPLE-LICENSE.txt`に置く。この試験用の信頼証明書と鍵は実購入の検証には使わない。

依存ライブラリが初期化時に乱数を使うため、リクエストの処理中に読み込む。Workerの起動時に静的に読み込むと、乱数生成を許さない実行環境で起動に失敗する。

## 読み込み範囲を減らした試験

`GET /apple-native-client-probe`は同じ3回の証明書・署名検証を行い、API用JWTの署名だけをWorkers標準のWebCryptoで実行する。公式ライブラリは検証モジュールを直接読み込む。Apple APIの実通信と証明書のオンライン失効確認は含めない。初回の読み込みを含むCPU時間を公開Workerで測定し、無料枠への適合を判断する。

## ネイティブの証明書処理を使う試験

`GET /apple-native-verifier-probe`では、チェーンの署名をNodeの`X509Certificate`、用途OIDの解析をASN1js、JWSの署名を公式ライブラリも使うjsonwebtokenで確認する。API用JWTはWebCryptoで署名する。暗号演算は自作しない。公式ライブラリのペイロード検証器はそのまま使う。

設定した信頼ルート、中間証明書のCA属性、発行者、両証明書のApple用途OID、署名日時に対する証明書の有効期間（公式と同じ60秒のずれ）、ES256署名、アプリ・環境を確認する。添付ルートを信頼しない。証明書のオンライン失効確認は他の試験と同じく行わない。

## 無料のDurable Objectsでの試験

`GET /durable-object-probe`は、Apple公式ライブラリの試験と同じ署名1回・検証3回をDurable Objectで実行する。入口のWorkerは呼び出しだけを行う。実際のAppleキー、Apple APIへの実通信、ストレージAPI、アラームは使わない。

無料のDurable ObjectsはSQLiteを伴い、CPU上限は標準で30秒。ここでは試験用のクラスを配置する。試験後にオーナーが製品への採用を承認し、購読確認サービスは別のWorkerへ配置した。入口のWorkerのCPU指標と、Durable Object内の検証処理は区別して記録する。

`test/subscription-native-verifier.test.mjs`で、Apple公式の公開試験データの一致と、改変・用途欠落・CA属性欠落・期限外等の拒否を公式検証器と比較する。`native-invalid-certificates.json`は正しく署名された公開試験用の欠陥証明書であり、実サービスへは使わない。購読確認サービスはまだ公式検証器を使っており、この試験だけでは実サービスへ採用しない。
