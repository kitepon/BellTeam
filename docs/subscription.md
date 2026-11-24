# 公開版の購読仕様

合意した仕様と実装の責務を記録する。準備状況・検証結果・続行条件は [subscription-setup.json](subscription-setup.json) が正本。

## 契約と利用権

- 利用者がサーバーを設置・運用し、AI各社も本人の契約で利用する。
- Webアプリと自己ホストのサーバーは無料。通常メンバー・ルームとの会話、Bot間の配送、予定の実行を購読なしで使える。AI各社や外部サービスの契約は利用者が用意する。
- 料金は購入元（App Store・Stripe・Google Play）を問わず月980円（税込）、最初の1か月は無料。購読は一つの購入元で足りる。どの購入元の購読も、同じBellTeamサーバーに接続した全アプリ（iPhone・Mac・Android・Windows・Linux）で有効になる。台数制限はなく、同じApple Accountの追加端末や接続先では購入を復元できる。購入画面に並べる購入元の順序と表示は [クライアント契約](billing-client-contract.md) に従う。Webは無料のまま。
- Appleアプリの入手とセットアップは無料。最初のハーネスの公式認証と案内役との初期設定を購入前に使える。初期設定の完了後、Appleアプリからの通常の会話、質問への回答、秘密入力の提出・取消、セッション再起動、予定の作成・編集・手動実行には購読が必要とする。閲覧・書き出し・管理・削除は無料。Appleの購入画面で利用者が承認した時に課金を開始する。
- 期限切れでもデータを削除しない。Appleアプリの有料操作だけを止める。Webからの会話、Bot間の配送、設定済みの予定は継続する。自動更新の停止だけでは支払済み期間を短縮しない。

## 購読確認の責務

AppleアプリはStoreKitで本人の購入・復元・取引の更新を受け取り、検証済みの現在の利用権と猶予期間から有料操作を判定する。起動・復元・取引更新・前面復帰・有料操作の直前に確認し、共有サーバーの`entitled`で別のApple Accountのアプリを解錠しない。署名付き購入情報を利用者のサーバーへ送り、運営による検証後にAppleへ取引の完了を伝える。復元の`AppStore.sync()`は利用者が復元を選んだ時だけ呼ぶ。商品とアプリの識別子は [product.json](../services/subscriptions/product.json) が正本。

初回の`GET /api/subscription`に失敗してサーバーの権利区分が未確認の時は、StoreKitの有効な利用権または初期案内の権利がある場合を除き、有料操作を止めて「確認できない」と案内する。未確認を未購入と断定しない。送信前の入力は保持し、設定の「BellTeamの購読」にある「再確認」はまずGETをやり直す。確認済みの開発者区分・有効購読・未購入はそれぞれの既存動作を保つ。

運営のCloudflareはAppleの最新購読状態を照会する。購入専用キーはCloudflareのsecretだけに置き、アプリ・利用者のサーバー・公開ソースへ含めない。会話本文やAIの認証情報を受け取らず、購読情報を保存しない。

オーナーの開発・運用環境では、対象サーバーの`BELLTEAM_SUBSCRIPTION_ACCESS_MODE=developer`でAppleアプリの購読を免除し、「開発者として利用中」と表示する。Appleへの購読照会・購入提示は行わず、`entitled`を有効と偽らない。一般配布版はこの免除を受け付けない。通常の`subscription`でもWebとサーバーは無料で、`canUseAI`は常にtrueを返す。`entitled`はAppleの購入情報を検証した結果だけを表す。

運営のWorker（Durable Objects）は2026-11-24に本体のリポジトリから取り除いた。ログイン・課金確認に自前のサーバーを使わない決定による（契約1.42）。取り付け済みの1.0.x アプリが読む旧い検証Workerだけが残り、止める時に消す（行`a540-old-verify-stop`）。

## Stripe（Appleアプリ以外の購入元）

WindowsとLinuxの利用者はStripeで同じBellTeamの月額購読（月980円、最初の1か月無料）を購入する。Appleの購読があれば、Stripeで買い足さずに使える。Appleの購入と同じく、運営のWorkerが購入元の最新状態を照会し、利用者のサーバーは結果だけを保存する。独自のライセンス・利用者ID・権利の台帳は作らない。

- サーバーの`POST /api/subscription/stripe/checkout`が購入画面のURLを返し、利用者はそこで購入する（最初の1か月は無料、料金は税込の980円。Stripe Taxを使い、価格は`tax_behavior=inclusive`で金額は変わらない）。戻り先で得たCheckout Session IDを`POST /api/subscription/stripe/verify`へ送ると、サーバーは購読IDを保存する。
- 状態は`GET /api/subscription`へApple同様に返し、`source`で購入元、`isTrial`で無料期間中かを示す。AppleとStripeの両方がある時は有効な方を使う。解約しても支払い済みの期間は使える（Appleと同じ）。
- 二重請求を起こさない：どの購入元でも課金中（解約予約中の支払済み期間・支払い再試行を含む）の間、サーバーはStripeの購入画面を作らず`SUBSCRIPTION_ALREADY_ACTIVE`（409）を返す。作った購入画面は保存し、購入が終わるまで同じ画面を返す。`GET /api/subscription`の`canPurchase`・`billingSources`で、Apple・Google Playのアプリも購入ボタンを止める。別々のサーバーは互いを知らないため、サーバーをまたぐ二重購入はこの仕組みの範囲外（クライアント契約の「同じアカウント」の定義どおり）。
- メールなしで解約できる：`POST /api/subscription/stripe/manage`がStripeの顧客ポータルのURLを返し、利用者はそこで解約・再開・支払い方法の変更をする。解約しても支払い済みの期間は使える。AppleとGoogle Playの購読の解約は各ストアで行う（[クライアント契約](billing-client-contract.md)）。
- Google Playで買った購読（Androidアプリ）：アプリが購入トークンを`POST /api/subscription/google/verify`へ送り、運営のWorkerがPlay Developer APIで購読を照会した結果をサーバーが保存する。サーバーが保存するのは購入トークンだけで、返却・ログには出さない。状態は`GET /api/subscription`へ同じ形で返し（`source:google`）、解約はGoogle Playの購読画面で行う。Playが確定前（`PENDING`）と示す購入は保存せず`GOOGLE_PURCHASE_PENDING`（409）。購入の確認済み（acknowledge）はアプリが、サーバーが有効と答えた後に行う。
- Appleアプリの画面からStripeへ誘導しない（Appleの審査指針3.1.1・3.1.3）。Stripeの購入画面を開く側はWindowsとLinuxだけ。Webは無料のため購入画面を持たない。
- Stripeの鍵・価格はWorkerのsecretだけに置く。未設定の間は`SUBSCRIPTION_NOT_CONFIGURED`を返す。実際のStripeとの通信は未検証。
- `canUseAI`は引き続き常にtrue。有料操作の範囲は各アプリが`entitled`で判定する（Appleアプリは本書の「契約と利用権」）。

## 利用者のサーバー

`shared/subscription.json`へ初期設定の完了・Appleの署名付き購入情報・照会結果を保存する。案内役は利用者と初期設定の完了に合意した時に`complete_setup`を使う。完了後もWebでは案内役を無料で使える。初回画面・設定API・保存先は [初期設定](onboarding.md) に従う。

サーバーのApple購読状態は最長1時間保持し、有効期限が先に来る場合は期限で再照会する。照会はAppleの購入・復元・購読画面の操作で行う。Webの送信・Botの起動・配送・予定実行では購読を照会しない。照会エラーは表示してAppleの検証結果を有効扱いにせず、Webの利用は継続する。エラー後は利用者が再確認・復元するまで自動の照会を止める。

通知登録では既存の端末トークンに本人の署名付き購入情報を保存する。運営の通知送信サービスは通知先端末の購入情報を検証し、他の端末の購入情報を使わない。運営へ送る情報は通知先と購入の検証に必要な範囲とし、独自の利用者IDや配送キューを追加しない。

`BELLTEAM_SUBSCRIPTION_ENVIRONMENT`は通常`Production`、TestFlightの購入試験では`Sandbox`とする。照会先は [endpoints.json](../services/subscriptions/endpoints.json) が正本。本番からSandboxへの自動切り替えはしない。環境を変えた時は購入情報を復元し直す。

認証済みのAPIは、購読がなくても会話・画像の閲覧と会話の書き出しを許す。`GET /api/bots/:id/export`と`GET /api/rooms/:id/export`は選択した会話を全件JSONで返す。iPhone・Macの会話上部とWebの書き出しボタンから保存できる。画像の参照URLを含み、画像本体は含まない。

## 実測の範囲

無料のDurable Objectsへ本番とSandboxの照会口を配置し、両方で不正なリクエスト・署名へのエラー応答を確認した。購入専用キーのsecret登録も完了している。Web無料・Appleアプリ購読への変更、サーバー・アプリの試験と配布の結果は準備状況の正本へ記録する。

iPhoneとMacの署名付きビルドをオーナー用TestFlightグループへ配布し、両方の内部テスト開始とApp Store版へのビルド割当をApple APIで確認した。アプリ分類はJevで選定した。ビルド番号・識別子・検証状態は準備状況の正本に記録している。

Appleの実購入・更新・復元・失効はまだ未検証。オーナー環境の開発者免除・正常起動・実際のAI送信と返答は確認済み。公開・課金まで完了したとは扱わない。

購入専用キーによるSandbox APIへの実通信は、試験用取引IDに4040010を返した。存在しないキーIDは401だったため、購入専用キーの認証は通ると判断した。Productionは管理用・購入専用キーの両方で401だった。[Apple担当者の説明](../rag/subscriptions/raw/apple-production-api-before-release.md)とアプリの公開前の状態から、未公開アプリへの利用制限と考えられる。公開後に再確認する。

CPU試験の数値・各試験の範囲・公開レポートは [report.json](../experiments/subscription-worker-probe/report.json) が正本。通常のWorkerでは証明書検証が無料枠のCPU上限を超えた。Durable Objectsの試験は公開データの検証が成功した。入口のCPU指標は無料枠内だったが、Object内のCPU集計は2期間とも空で、測定できていない。Apple APIへの実通信を含む負荷試験ではない。

## 続行条件

App Store Connect APIはこのMacの登録済みMCPから利用できる。日本の販売地域は登録済み。App Storeの登録価格は月300円のままで、月980円・最初の1か月無料への変更はApp Store Connectで未完了。有料App契約・銀行口座・納税フォームの有効表示はAppleのWeb画面で確認した。契約同意・銀行・税務情報の入力は行っていない。使用した認証用ブラウザタブは終了している。

年齢区分、審査画面と審査用の接続環境を整え、TestFlightで購入・復元を確認する。ソースは非公開で、一般配布のDockerイメージと設置用ファイルは未認証で取得できる。本番サーバーの再起動を伴う反映は、オーナーの個別の許可を得てから正規のデプロイ入口で行う。
