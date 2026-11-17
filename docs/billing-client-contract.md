# Billing client contract (a358)

What every BellTeam app shows on its purchase page and how it reads the result. The server side is in [subscription.md](subscription.md); the Worker is in [services/subscriptions/README.md](../services/subscriptions/README.md). Owner ruling 2026-11-17: all stores cost the same, every app can sign in to the same account, each platform lists its own store first, and the options are shown at the same size and as equals.

## Terms

- Price: 980 yen per month, tax included, in every store. First month free in every store (Apple introductory offer, Google Play free trial, Stripe `trial_period_days=30`).
- Web is free and has no purchase page. A self-hosted server and the Web app never require a subscription.
- "Same account" means the same BellTeam server. A subscription bought in any store is saved on the server that app is connected to and unlocks every app connected to that server. The server keeps one verdict per store and uses the entitled one (`source` says which). There is no cross-server subscriber id; a different server needs the purchase restored there.
- Google Play: the contract is fixed here; the server check is added by a157 after the Android client exists. Until then the Google Play option is shown but the Android app cannot unlock through it.

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

All apps read `GET /api/subscription`: `entitled`, `source` (`apple`, `stripe` or later `google`; `null` when none), `isTrial`, `state`, `autoRenewing`, `validUntil`, `error`, and since a389 `billingSources` (stores that still bill: `active`, `grace` or `billing_retry`) and `canPurchase` (`true` only when `billingSources` is empty and the server is not in developer mode). Windows and Linux open the Stripe page with `POST /api/subscription/stripe/checkout` (returns `{url, sessionId}`; open `url` in the system browser; pressing it again while that page is still open returns the same `url`; it is refused with `SUBSCRIPTION_ALREADY_ACTIVE` when any store already bills this server) and send the returned session id to `POST /api/subscription/stripe/verify` after the user comes back. Apple apps keep StoreKit and `POST /api/subscription/verify` with the signed transaction. `canUseAI` stays true; each app decides its own paid operations from `entitled`.

## Who follows this

Rapi (iPhone/Mac, a359), Anis (Windows, a360), Neon (Linux a337, Android a350). A client that needs a different option, wording or order asks Bready first; the contract changes here, not in the client.
