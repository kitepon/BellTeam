# RAG目録

- [アプリから自分のサーバーへ接続するまで](docker-server-setup/app-first-entry.md)と[Docker公式の導入入口](docker-server-setup/raw/official-guide-links.md): 接続前のアプリ内ガイド、Docker・Compose・WSL、同一マシンとLANのURL。取得日 2026-10-05。

- [会話本文のMarkdown表示](markdown-display/enriched-markdown.md)と[EnrichedMarkdown公式資料](markdown-display/raw/enriched-markdown-readme.md): 標準描画・範囲選択・表のコピー、iPhoneとMac Catalystでの実測。取得日 2026-10-05。

- [Release版の実機試験](apple-networking/raw/testing-a-release-build.md): 通信障害の実測と、開発端末のNetwork Link Conditionerを使うApple公式原文。取得日 2026-10-04。

- [URLSessionのflush](apple-networking/raw/urlsession-flush.md): Cookie・認証情報を保存し、以後の要求を新しいTCP接続で行うApple公式仕様。取得日 2026-10-04、一次資料の原文。
- [URLSessionの接続再利用の計測](apple-networking/raw/reused-connection.md): 要求で持続接続を再利用したかを表すisReusedConnectionのApple公式仕様。取得日 2026-10-04、一次資料の原文。
- [CFNetwork診断ログ](apple-networking/raw/cfnetwork-diagnostics.md): HTTPS通信の診断、起動時の環境変数、iOSのUSB接続とConsoleでの採取手順。取得日 2026-10-04、Apple公式原文。

- [Mac Catalystの表示倍率](mac-typography/raw/mac-catalyst-source.md): iPad向けUIの77%表示とMac用UIの仕様を示すApple公式JSON原文。取得日 2026-10-03。

- [Apple APIクライアントの通信拡張点](subscriptions/raw/apple-api-client-source.md)、[Workersの標準通信](subscriptions/raw/cloudflare-fetch.md): 公式クライアントの認証・応答解析を維持して標準fetchを使うための開発元原文。取得日 2026-10-03。

- [iPhoneミラーリングの操作](app-review/raw/apple-iphone-mirroring.html): 接続時の端末確認、マウス・トラックパッドによる操作、利用できない端末機能のApple公式HTML原文。取得日 2026-10-03。

- [Cloudflareの汎用OIDC](app-review/raw/cloudflare-generic-oidc.md)、[ワンタイムPIN](app-review/raw/cloudflare-onetimepin.md)、[Dexのローカルユーザー](app-review/raw/dex-local-users.html): 審査用のユーザー名・パスワード認証をCloudflare Accessへ接続する公式原文。取得日 2026-10-02。
- [AIアプリの年齢申告](app-review/raw/apple-age-rating-ai.html): AIアシスタント・チャットボットの生成内容を年齢質問票へ含めるApple公式HTML原文。取得日 2026-10-02。
- [購読の販売地域](app-review/raw/apple-subscription-availability.html): 販売地域を限定する場合も全地域の価格を設定するApple公式HTML原文。取得日 2026-10-02。
- [Workerの実効設定](app-review/raw/cloudflare-worker-settings.md): 公開WorkerとSandbox Workerのログ・保持・サンプリングを読み取るCloudflare公式API原文。取得日 2026-10-02。

- [Apple審査の登録項目schema](subscriptions/raw/apple-review-submission-item-schema.md): 初回の購読版・グループ版とアプリ版を同じ審査draftへ登録するrelationshipのApple公式OpenAPI原文抜粋。取得日 2026-10-02。

- [UITextViewの範囲選択](native-text/raw/uitextview-selection.md)、[編集可否](native-text/raw/uitextview-editing.md)、[SwiftUI内のサイズ計算](native-text/raw/uiview-sizing.md)、[Markdownの表示属性](native-text/raw/inline-presentation.md): iPhone・Mac共通の本文で部分選択とコピーを使い、リンク・強調・改行を保つためのApple公式原文。取得日 2026-09-30。
- [SwiftUIの画面識別と状態](native-text/raw/view-identity.md): 会話の宛先変更時に表示状態を切り替える`id(_:)`のApple公式原文。取得日 2026-09-30。

- [Xcodeの自動ビルド用署名](subscriptions/raw/github-xcode-signing.html): 配布専用キーチェーンへの証明書取り込み、Appleツールのpartition設定、ビルド後の後片付け。取得日 2026-09-28、GitHub公式HTML原文。

- [Appleの配布署名API入力](subscriptions/raw/apple-signing-api-schema.md): CSRからの証明書作成と、iPhone・Mac Catalystの配布用プロファイル作成の公式schema。取得日 2026-09-28、Apple公式OpenAPI原文抜粋。

- [Macのアプリ分類](subscriptions/raw/apple-mac-category.md): Mac App Storeへのアップロードに必要なLSApplicationCategoryTypeの公式値。取得日 2026-09-28、Apple公式原文。
- [Appleの年齢区分](subscriptions/raw/apple-age-ratings.html): 年齢申告の項目と、Web閲覧・公開UGC・利用者間チャットの定義。取得日 2026-09-28、Apple公式HTML原文。
- [Appleの販売地域登録schema](subscriptions/raw/apple-app-availability-schema.md): 販売可能・不可の地域を含むAppAvailabilityV2CreateRequestの公式入力。取得日 2026-09-28、Apple公式OpenAPI原文抜粋。
- [AppleのSandbox購入試験](subscriptions/raw/storekit-sandbox.md): TestFlightと開発版の購入環境、試験取引では実際の支払いを処理しないこと、実商品を使う試験の準備。取得日 2026-09-28、Apple公式原文。
- [Apple配布証明書の作成属性](subscriptions/raw/apple-certificate-attributes.md): 証明書種別とCSRを指定する公式APIの入力。取得日 2026-09-28、Apple公式原文。
- [Cloudflareの処理ログ](subscriptions/raw/cloudflare-workers-logs.md): 呼び出しログ、コンソール出力、保持期間、無料プランのログの扱い。取得日 2026-09-28、Cloudflare公式原文。
- [Cloudflareのプライバシー方針](subscriptions/raw/cloudflare-privacy-policy.html): API利用時のIPアドレスなど、サービス利用者の通信に伴うデータの取り扱い。取得日 2026-09-28、Cloudflare公式HTML原文。
- [Mac App Sandboxの設定](subscriptions/raw/apple-mac-app-sandbox.md): Mac App Storeに必要なSandboxと通信・ファイル権限の公式設定。取得日 2026-09-28、Apple公式原文。
- [Appleの暗号利用の申告](subscriptions/raw/apple-export-encryption.md): OSに組み込まれたHTTPS通信と、独自の暗号実装の区別。取得日 2026-09-28、Apple公式原文。

- [Workersの上限](subscriptions/raw/cloudflare-workers-limits.md): 無料枠のCPU・リクエスト・外部通信の上限。取得日 2026-09-28、一次資料の原文。
- [Workersの時計](subscriptions/raw/cloudflare-performance.md): 公開Workerの時計はI/Oまで進まないため、暗号処理のCPU計測はCloudflareのCPU指標を使う。取得日 2026-09-28、一次資料の原文。
- [Durable Objectsの料金](subscriptions/raw/cloudflare-durable-objects-pricing.md)、[上限](subscriptions/raw/cloudflare-durable-objects-limits.md): 無料プランの対象、CPU上限、無料枠の超過時の動作と空のSQLiteの使用量。取得日 2026-09-28、Cloudflare公式原文。
- [Durable Objectsの基底クラス](subscriptions/raw/cloudflare-durable-objects-base.md)、[呼び出し](subscriptions/raw/cloudflare-durable-objects-namespace.md)、[計測](subscriptions/raw/cloudflare-durable-objects-metrics.md): 処理の呼び出しと公式の計測API。取得日 2026-09-28、Cloudflare公式原文。
- [Apple購読APIのキー](subscriptions/raw/apple-create-iap-key.md)、[JWT](subscriptions/raw/apple-api-jwt.md): App Store Connectの管理用キーとアプリ内課金用キーの用途、Issuer・Bundle IDを含む認証形式。取得日 2026-09-28、Apple公式原文。
- [Apple購読状態の照会](subscriptions/raw/apple-all-subscription-statuses.md)、[状態](subscriptions/raw/apple-status.md): 最新取引・更新情報の照会と購読状態。取得日 2026-09-28、Apple公式原文。
- [公開前のProduction API利用](subscriptions/raw/apple-production-api-before-release.md): 未公開アプリへのProduction API利用制限についてのApple担当者の原文抜粋。取得日 2026-09-28、一次資料。
- [Apple購読価格の設定](subscriptions/raw/apple-subscription-pricing.md): 地域別の価格ID・価格登録と、年間契約の月払いを表すplanTypeの区別。取得日 2026-09-28、Apple公式原文。
- [Apple購読の管理](subscriptions/raw/apple-manage-subscriptions.md)、[地域別価格の設定](subscriptions/raw/apple-configure-pricing.md): 販売地域と地域別の価格を登録するAPI、提供地域ごとに必要な価格登録、月払い年間契約の区別。取得日 2026-09-28、Apple公式原文。
- [CodexのMCP設定](subscriptions/raw/codex-mcp-configuration.md): STDIOと環境変数による外部MCPの登録、設定の共有と確認方法。取得日 2026-09-28、OpenAI公式原文。
- [ASC MCPのREADME](subscriptions/raw/apple-asc-mcp-readme.md): 既存のASCキーを参照する設定と標準診断、アプリ・購読情報を扱うツール。取得日 2026-09-28、開発元の原文。
- [StoreKitの取引](subscriptions/raw/storekit-transaction.md): Appleの署名付き購入情報、端末間の購入取得、購入完了と更新の通知。取得日 2026-09-28、Apple公式原文。
- [現在の購入権](subscriptions/raw/storekit-current-entitlements.md)、[取引の属性](subscriptions/raw/storekit-transaction-properties.md)、[購読状態](subscriptions/raw/storekit-subscription-status.md): 端末本人の購入権、有効期間と支払い猶予期間、原取引・失効・所有権の確認。取得日 2026-10-02、Apple公式原文。
- [StoreKitの購入](subscriptions/raw/storekit-purchase.md)、[SwiftUIからの購入](subscriptions/raw/storekit-purchase-action.md)、[購入の復元](subscriptions/raw/storekit-restore.md): Appleの確認画面での購入、iPhoneとMac Catalystでの画面に応じた購入表示、利用者の操作時だけ行う復元。取得日 2026-09-28、Apple公式原文。

- [UIKeyCommandの入力優先順位](mac-keyboard/raw/uikeycommand-priority.md): キーコマンドをテキスト入力より先に処理するApple公式仕様の原文抜粋。
- [Macのウィンドウサイズ制約](mac-window/raw/size-restrictions.md): UIWindowScene.sizeRestrictionsで最小・最大サイズを設定するApple公式仕様の原文。
- [SwiftUIの初期ウィンドウサイズ](mac-window/raw/default-size.md)、[最小サイズだけの制限](mac-window/raw/content-min-size.md): 初期値とサイズ制約を区別するApple公式仕様の原文。Catalystでの実測はdocs/mac-app.md。
- [SwiftUIのウィンドウ群](mac-window/raw/windowgroup.md)、[ウィンドウを開く操作](mac-window/raw/openwindow.md)、[複数シーンの設定](mac-window/raw/multiple-scenes.md): メンバー編集用の独立ウィンドウを開くためのApple公式仕様の原文。
- [Mac Catalystのウィンドウ位置・大きさ](mac-window/raw/geometry-preferences-mac.md)、[ジオメトリ変更要求](mac-window/raw/request-geometry-update.md): SwiftUIの理想サイズが初期値に反映されない場合に、対象シーンへ希望サイズを渡すApple公式仕様の原文。

- [Cloudflare Tunnel構成更新API](cloudflare-tunnel/raw/update-configuration.md): 遠隔管理TunnelのingressをPUTで更新する公式仕様。取得日 2026-09-25、一次資料。
- [Cloudflare Accessの自己ホスト型アプリ](cloudflare-access/raw/self-hosted-public-app.md): 公開hostnameとAllow policyによる保護の公式手順。取得日 2026-09-26、一次資料。
- [Cloudflare Access JWTの検証](cloudflare-access/raw/validate-jwts.md): originでの`Cf-Access-Jwt-Assertion`検証、署名鍵、発行元、audienceの公式手順。取得日 2026-09-26、一次資料。
- [GitHub CLIのLinux導入](github-cli/raw/install_linux.md): 公式Debianパッケージリポジトリからの`gh`導入手順。取得日 2026-09-26、一次資料。
- [ランタイムの現行版導入](runtime-updates/raw/update-commands.md): Dockerのキャッシュなしビルドとベースイメージ更新、Nodeのcurrentタグ、Corepackの配布変更と公式導入、npmのlatestタグ、Cursorの公式更新コマンドの原文。取得日 2026-09-27、一次資料。
- [TypeSafe HTTP API](typesafe-ai/raw/api.md): Jevの一括Noul・Choice判定の要求形式と応答形式を示す公式仕様。取得日 2026-09-27、一次資料。
- [TypeSafe Noul](typesafe-ai/raw/noul.md): yes/no確率の意味と閾値選定の公式仕様。取得日 2026-09-27、一次資料。
- [TypeSafe Choice](typesafe-ai/raw/choice.md): 候補の記述と選択肢の確率分布を示す公式仕様。取得日 2026-09-27、一次資料。
- [TypeSafe State](typesafe-ai/raw/state.md): 会話と関連情報を構造化して渡す公式仕様。取得日 2026-09-27、一次資料。

- [secret-input/raw/mcp-elicitation.md](secret-input/raw/mcp-elicitation.md) — 秘密情報をform elicitationへ流さない公式仕様の原文抜粋。
- [secret-input/raw/apple-redirect.md](secret-input/raw/apple-redirect.md) — URLSessionのリダイレクト拒否に関するApple公式の原文抜粋。

- [Nodeの証明書API原文](subscriptions/raw/node-x509-crypto.md)、[ASN1js原文](subscriptions/raw/asn1js-readme.md)、[Appleの検証器原文](subscriptions/raw/apple-jws-verification-3.1.0.md) — ネイティブの証明書検証を公式の確認条件と比較する一次ソース。

- [GitHubのContainer Registry](subscriptions/raw/github-container-registry.html)、[パッケージの権限](subscriptions/raw/github-package-permissions.html): GITHUB_TOKENによる公開、初回はPrivate、publicの未認証取得。取得日 2026-09-28、GitHub公式HTML原文。
- [Appleの画面画像仕様](subscriptions/raw/apple-screenshot-specifications.html): 必要なiPhone画面サイズ、JPEG・PNGと透過禁止、Macの対応サイズ。取得日 2026-09-28、Apple公式HTML原文。

- [SwiftUIの削除確認](room-deletion/raw/swiftui-alert.md): データを渡すalertとdestructive・cancel操作のApple公式仕様の原文。取得日 2026-09-30、一次資料。

- [iPadの分割表示](ipad-layout/raw/navigation-split-view.md)、[詳細パネル](ipad-layout/raw/inspector.md)、[可変サイズのウィンドウ](ipad-layout/raw/full-screen-migration.md): 共通画面の列の折り畳み・詳細のシート表示・全画面固定の解除に関するApple公式原文。取得日 2026-09-30。

- [Device Hub](ipad-layout/raw/device-hub.md): Xcodeの端末・シミュレーター操作を行うApple公式資料の原文。取得日 2026-10-01。

- [Communication Notifications](communication-notifications/raw/implementation.md): 送り主・グループ画像、Intentの寄付、通知内容の更新に関するApple公式原文。取得日 2026-10-02。

- [Cursor](container-platforms/raw/cursor-installer.md)、[Grok](container-platforms/raw/grok-installer.md)、[RTK](container-platforms/raw/rtk-installer.md)の公式installer原文: Linux amd64・arm64の導入分岐。取得日 2026-10-02、一次資料。

- [Appleの設定領域](subscriptions/raw/apple-preference-domains.html): コマンドライン引数による一時的な設定と保存済み設定の優先順位。取得日 2026-10-03、一次資料。
- [AppleのApp Privacy定義](subscriptions/raw/apple-app-privacy-details.html): 収集、本人への関連付け、追跡とIPの用途別申告。取得日 2026-10-03、一次資料。
- [Cloudflareのトークン権限](subscriptions/raw/cloudflare-token-permissions.md): 組織とIdPの独立した編集権限、Workerログ照会の権限定義。取得日 2026-10-03、一次資料。

- [Apple購読状態の応答schema](subscriptions/raw/apple-status-response-source.md): 公式StatusResponseのappAppleIdを含む任意項目と検証器。

- [Apple StoreKit transaction/currententitlements](subscriptions/raw/apple-current-entitlements.md) — Appleの購読照会・復元の公式原文。

- [Apple StoreKit appstore/sync()](subscriptions/raw/apple-appstore-sync.md) — Appleの購読照会・復元の公式原文。

- [StoreKit TestとiOS 26.5の不具合](subscriptions/raw/apple-storekit-test-ios265-forum.html) — 設定転送の既知問題とApple DTSの回答。

- [Apple審査提出の更新API](subscriptions/raw/apple-review-build-replacement.md): 提出の送信・取消に使う属性。Apple公式資料の原文。
- [Apple購入メタデータのv2移行](subscriptions/raw/apple-iap-metadata-v2-migration.md): 初回購読と購読グループの版をアプリと同じ審査へ追加する手順。Apple公式資料の原文。

- [Cloudflareのセッション管理](cloudflare-access/raw/session-management.md)と[認証Cookie](cloudflare-access/raw/authorization-cookie.md): アプリ・グローバルのトークンと期限、SSOの公式原文。取得日 2026-10-04。
- [XcodeGenのProject Spec](xcodegen/raw/project-spec.md): TestActionだけへの起動引数と明示的なschemeの公式原文。取得日 2026-10-04。

- [購読版](app-review/raw/working-with-subscription-versions.md)、[購読グループ版](app-review/raw/working-with-subscription-group-versions.md)、[審査提出](app-review/raw/submitting-subscriptions-and-subscription-groups-for-app-review.md): 各版の状態遷移、審査項目への追加と送信、初回購読をアプリ本体と提出する条件。取得日 2026-10-04、Apple公式原文。
