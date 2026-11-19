# Billing client contract (a358)

What every BellTeam app shows on its purchase page and how it reads the result. The server side is in [subscription.md](subscription.md); the Worker is in [services/subscriptions/README.md](../services/subscriptions/README.md). Owner ruling 2026-11-17: all stores cost the same, every app can sign in to the same account, each platform lists its own store first, and the options are shown at the same size and as equals.

## Terms

- Price: 980 yen per month, tax included, in every store. First month free in every store (Apple introductory offer, Google Play free trial, Stripe `trial_period_days=30`).
- Web is free and has no purchase page. A self-hosted server and the Web app never require a subscription.
- "Same account" means the same BellTeam server. A subscription bought in any store is saved on the server that app is connected to and unlocks every app connected to that server. The server keeps one verdict per store and uses the entitled one (`source` says which). There is no cross-server subscriber id; a different server needs the purchase restored there.
- Google Play (a157): the Android app buys the Play subscription and sends the purchase token to `POST /api/subscription/google/verify`; the server asks the operator Worker, which reads the purchase from the Play Developer API, and the result joins the other stores like Apple and Stripe. The Android app acknowledges the purchase only after the server says `entitled`.

## Options each app lists

Every app lists all three purchase sources, in this order: its own platform's store first, then the other two in the order App Store, Google Play, Stripe.

| App | 1st | 2nd | 3rd |
| --- | --- | --- | --- |
| iPhone / Mac (Apple) | App Store | Google Play | Stripe |
| Android | Google Play | App Store | Stripe |
| Windows / Linux | Stripe | App Store | Google Play |
| Web | no purchase page; free wording only | | |

Only the first row of each app can be bought on that device. The other two are information rows (Apple and Google Play rules forbid steering to another payment method inside their apps; Windows and Linux have no store of the others).

## Layout rules

1. One row per source, same height, same font size and weight, same icon size, same spacing. No row is highlighted by size, color weight or badge. The only difference is the button.
2. Each row says: store name, `月980円（税込）`, `最初の1か月無料`.
3. The buyable row has the purchase button (`購入`, or `購入を復元` for Apple and Google Play).
4. A row that cannot be bought on this device has no button and no link. It shows the line `この端末では購入できません。{store}で購入した購読も、同じサーバーでこのアプリに使えます。` ({store} is `App Store`, `Google Play` or `Stripe`).
5. If the server reports `entitled: true`, show the active state for every row's source: `購読中（{store}）` on the row of `source`, and keep the others as in rule 4.
6. Show a purchase button only while `canPurchase` is `true`. The server sets it to `false` whenever any store still bills this server (`billingSources` is not empty), also while the subscription is cancelled but paid until `validUntil`, and while a payment is being retried. This is how nobody is charged twice: the Apple and Google Play apps cannot be stopped by the server, so they must read this field before they show or run a purchase. A client that cannot read it (the server is unreachable) shows no purchase button.
7. While `isTrial: true` show `無料期間中`, with the date from `validUntil`.
8. The row of every source in `billingSources` has one manage button, `購読を管理・解約`, at the same place and size in every app (see Cancel and manage).

## Confirmation panel before Stripe (a460)

Windows and Linux (the Stripe row) show this panel when the person presses 購入, before the app asks the server for the Checkout page (特定商取引法12条の6: the contract terms must be shown on the screen right before the order, in a way the person can check and correct). The wording is Poli's (kitepon.dev legal); the app shows it exactly, with one dynamic date. Rows for the other stores keep the rules above and never show this panel.

| Line | Text |
| --- | --- |
| Title | `購入内容の確認` |
| Plan | `BellTeamの月額購読（解約するまで毎月自動で更新）` |
| Price | `月額980円（税込）。1年続けた場合の合計の目安：11,760円` |
| Payment method | `クレジットカード、Apple Pay、Google Pay（Stripe）` |
| First charge | `最初の1か月は無料です。{date}に初回の980円を決済し、以後は毎月の更新日に自動で決済します。` ({date} = today + 30 days, local date, `yyyy年M月d日`) |
| Start | `支払い手続きの完了後、サーバーが契約を確認した時点から使えます（無料期間中も使えます）。` |
| Cancel | `いつでも「設定 > BellTeamの購読」→「購読を管理・解約」から解約できます。支払い済みの期間の終わりに終了します。無料期間中に解約すれば料金はかかりません。` |
| Refund | `デジタルサービスのため、申込み後の返金・撤回はできません。ただし二重請求などは返金します。詳しくは特定商取引法に基づく表記をご覧ください。` |
| Link | `特定商取引法に基づく表記` → `https://kitepon.dev/specified-commercial-transactions/#bellteam` (system browser) |
| Terms notice | `申し込むと、利用規約とBellTeam付属規約に同意したことになります。` with links to `https://kitepon.dev/terms/` and `https://kitepon.dev/apps/bellteam/terms/` |
| Buttons | `申し込む（Stripeの支払い画面へ進む）` (asks the server for the Checkout page and opens it) and `戻る` (closes the panel, nothing is sent) |

The panel is a step inside the same row, not a second page: `SUBSCRIPTION_ALREADY_ACTIVE` and the other errors are handled as before after 申し込む. The Checkout page (Worker `STRIPE_REQUIRE_TERMS`) asks for the same consent again on Stripe's side.

## Cancel and manage (a389)

The subscriber cancels from the product, never by email. The button sits on the row of each store in `billingSources`:

| Source | What the button does |
| --- | --- |
| `stripe` | Calls `POST /api/subscription/stripe/manage` (no body). It returns `{url}`; open `url` in the system browser. Stripe's page lets the subscriber cancel, undo a cancellation, change the card and read invoices. Cancelling keeps the subscription usable until `validUntil`; the app learns of it on the next `GET /api/subscription` (use `POST /api/subscription/refresh` after the person comes back). |
| `apple` | Opens the platform's own subscription settings (iPhone/Mac: the existing manage-subscriptions link). No server call. |
| `google` | Opens Google Play's subscriptions page. No server call. |

While `autoRenewing` is `false` and `entitled` is `true`, also show `次回の更新はありません。{validUntil}まで使えます。` on that row. To buy again before that date, the subscriber undoes the cancellation through the same button; no second purchase is offered (rule 6).

Errors: `NO_STRIPE_SUBSCRIPTION` (409) means the server has no Stripe subscription, so show no manage button for Stripe. `SUBSCRIPTION_ALREADY_ACTIVE` (409) from `POST /api/subscription/stripe/checkout` means the server refused a second purchase: show its `message` and refresh the status. Other errors show their `message` as for every call.

## Reading the result

All apps read `GET /api/subscription`: `entitled`, `source` (`apple`, `stripe` or `google`; `null` when none), `isTrial`, `state`, `autoRenewing`, `validUntil`, `error`, and since a389 (older servers omit them: then treat `canPurchase` as true only when `state` is `not_purchased`, `expired` or `revoked`, and `billingSources` as empty) `billingSources` (stores that still bill: `active`, `grace` or `billing_retry`) and `canPurchase` (`true` only when `billingSources` is empty and the server is not in developer mode). Windows and Linux open the Stripe page with `POST /api/subscription/stripe/checkout` (returns `{url, sessionId}`; open `url` in the system browser; pressing it again while that page is still open returns the same `url`; it is refused with `SUBSCRIPTION_ALREADY_ACTIVE` when any store already bills this server) and send the returned session id to `POST /api/subscription/stripe/verify` after the user comes back. Apple apps keep StoreKit and `POST /api/subscription/verify` with the signed transaction. The Android app sends `{purchaseToken, productId}` to `POST /api/subscription/google/verify` (`productId` is accepted but not used: the Worker checks the product on the Play purchase itself and answers `INVALID_PRODUCT` for another product; a purchase Play still marks pending returns `GOOGLE_PURCHASE_PENDING` (409) and is not stored; a developer-mode server answers `SUBSCRIPTION_NOT_REQUIRED` (409)); the answer has the same `{subscription}` shape as the Apple call. `canUseAI` stays true; each app decides its own paid operations from `entitled`.

## Who follows this

Rapi (iPhone/Mac, a359), Anis (Windows, a360), Neon (Linux a337, Android a350). A client that needs a different option, wording or order asks Bready first; the contract changes here, not in the client.
