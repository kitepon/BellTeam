# Windows Store版：クオ君にしかできない手順と現在地

工程L-2（アプリを閉じている間もWindowsに更新通知を出す）のうち、Microsoftのアカウント操作と本人確認が要る手順。上から順に進める。仕組みは[Windowsの機能図](windows-architecture.md#終了中の更新通知microsoft-store版)、パッケージの作り方は[Windowsアプリ](windows-app.md#microsoft-store版)。

秘密の値（WNSの秘密値）は、会話・メール・文書へ書かない。ミカが出す秘密入力カードへだけ入れる。Package SIDも同じカードで入れる。

## 手順

1. **Microsoft Storeの個人開発者として登録する（無料）**
   - <https://storedeveloper.microsoft.com> から始める。個人（Individual）を選ぶ。
   - 本人確認で、政府発行の身分証（運転免許証など）と自撮りを撮る。スマホで、明るい場所で、原本を使う。
   - 登録料19ドルは新しい登録の流れでは不要。クレジットカードの要否と審査にかかる時間は、Microsoftの資料に書かれていない。カードを求められたら、そこで止めてベルに知らせる。

2. **アプリ名「BellTeam」を予約する**
   - Partner Centerの「アプリとゲーム」→「新しい製品」→「MSIX or PWA app」で、名前に`BellTeam`を入れて予約する。
   - 予約した名前は、3か月以内に提出しないと消える。
   - 名前が取れなかった場合は、取れた名前をベルに知らせる（アプリ内の表示名は変えずに進められる）。

3. **Product identityの値をベルに知らせる（公開値。秘密ではない）**
   - 予約したアプリの「製品管理」→「Product identity」を開く。
   - 次の4つを会話で知らせる。`Package/Identity/Name`、`Package/Identity/Publisher`、`Package/Properties/PublisherDisplayName`、`Package Family Name (PFN)`。`Package SID`だけは、手順4でミカの秘密入力カードへ入れる。

4. **WNSの秘密値を作り、ミカの秘密入力カードへ入れる**
   - 同じアプリの「製品管理」→「WNS/MPNS」→「App Registration portal」を開く。Partner Centerがこのアプリ用に紐づけた登録が開く。Azureのポータルで自分で新しく登録を作らない。
   - 「Certificates & secrets」→「Client secrets」→「New client secret」で秘密値を作る。値は作った直後の画面でしか見られないので、そのままミカの秘密入力カードへ入れる。Package SIDも同じ時に入れる。
   - 有料のAzureサブスクリプション、支払い方法の登録、Microsoftへのメール申請を求められたら、そこで止めてベルに知らせる（オーナー裁定の無料経路から外れるため）。
   - 既知のリスク: 2026年4月のMicrosoft Q&Aに、個人のMicrosoftアカウントで「WNS/MPNS」に秘密値の欄が出ないという報告があり、Microsoftの担当者はPartner Centerの不具合として問い合わせを勧めている（未解決）。欄が出なければ、画面の写真をベルに送ってほしい。サポートへの問い合わせはクオ君のアカウントでしかできない。

5. **Storeへ提出する（ベルがMSIXを作った後）**
   - ベルが手順3の値で作ったMSIX（`BellTeam_<版>_x64.msix`）をアップロードする。
   - 提出時の記入: 説明文・スクリーンショット・プライバシーポリシーのURL・年齢区分。文面と画像はベルが用意する。
   - 「runFullTrust」（制限付きの権限）の理由欄には、ベルが用意する文面を貼る。内容は「WPFのデスクトップアプリで、MSIX化した既存のデスクトップ版を配布するため」。
   - 公開範囲: 一般公開にしない場合は「Private audience」（指定したMicrosoftアカウントだけが見られる）を選べる。どちらにするかはクオ君が決める。
   - Microsoftの審査には数営業日かかることがある。

6. **実機確認（次の回）**
   - 1台のWindowsでStoreから入れる。BellTeamを開いて接続し、設定の「このPCの通知」をオンにする。
   - アプリを閉じて、更新の通知がWindowsに出ることを見る。通知を押すと、BellTeamのUpdate画面が開くことを確かめる。

## 現在地

- 2026-11-08: 図・クライアントの実装・パッケージ作成スクリプトをPRにした。仮の識別値でのMSIX作成と、パッケージ識別ありでの起動・読み取りsmoke・WNSチャネル取得は、FOXで確認済み。
- 手順1〜5はクオ君の操作待ち。サーバー・中央の送信（WNSへの送信、登録の台帳、箱ごとの取り消せる合言葉）はミカが作業中。
