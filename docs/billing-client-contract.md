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
5. If the server reports `entitled: true`, show the active state for every row's source: `購読中（{store}）` on the row of `source`, and keep the others as in rule 4. Do not offer a second purchase while entitled.
6. While `isTrial: true` show `無料期間中`, with the date from `validUntil`.

## Reading the result

All apps read `GET /api/subscription` (unchanged): `entitled`, `source` (`apple`, `stripe` or later `google`; `null` when none), `isTrial`, `state`, `validUntil`, `error`. Windows and Linux open the Stripe page with `POST /api/subscription/stripe/checkout` (returns `{url, sessionId}`; open `url` in the system browser) and send the returned session id to `POST /api/subscription/stripe/verify` after the user comes back. Apple apps keep StoreKit and `POST /api/subscription/verify` with the signed transaction. `canUseAI` stays true; each app decides its own paid operations from `entitled`.

## Who follows this

Rapi (iPhone/Mac, a359), Anis (Windows, a360), Neon (Linux a337, Android a350). A client that needs a different option, wording or order asks Bready first; the contract changes here, not in the client.
