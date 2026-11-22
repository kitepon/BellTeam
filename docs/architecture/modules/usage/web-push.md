# Web push（廃止済み）

2026-11-22、オーナーの決定でブラウザー版が廃止され、Web pushの送信・HTTP入口・`webPush`設定・VAPID鍵と購読ファイルは取り除かれた（a487n）。
以前の契約（Root固定v1.1、登録/鍵writer、origin、安全な終端、ABI2）は、git履歴の`docs/architecture/modules/usage/web-push.md`と
[アーカイブ](../../../archive/web-ui/web-push.md)に残る。ネイティブのプッシュ（APNs・FCM）は変わらない。

## Removal of Web push (a487n, 2026-11-22; the browser version is abolished)

No client is left that can register a Web push subscription (the Owner abolished the browser version; Admi's #2239 removes `web/`). Web push sending, its HTTP routes, the `webPush` setting and the VAPID/subscription files go. The halves ship apart (body, usage module, notifications module), so the removal is two stages, readers before writers (`runtime/module-ipc.md` "Records between halves that ship apart"):

| Stage | Change | Why this order |
| --- | --- | --- |
| 1 (this change) | Every reader accepts the shape with and without `webPush`: the notifications IPC validator (`ready.status`, `ready.applyError`, the `initialize` configuration), the notifications child's `initialize`, the body's settings list / projection row / usage `stateCompatibility` (any combination of the two optional features `webPush`, `thinkingDisplay`) and the usage handoff epochs. Writers still send `webPush`. | A reader that is not yet shipped would refuse the writer that has stopped sending it. |
| 2 (done in this change, after stage 1 was out on all three halves) | Writers stop: the usage child no longer lists `webPush` (and drops a stored entry on load), the body stops sending the `webPush` configuration, the notifications child stops reporting it; `/api/web-push/*`, `PATCH /api/settings/webPush`, the provider, `web-push-origin`, the `web-push` dependency, the file lists and the stored VAPID key and subscription files are removed. | Only now is no reader left that needs the key. |

Clients: the apps read the settings list as a list (iPhone `FeatureSettingsView` only maps an icon for the id `webPush`; Windows, Linux and Android hold no `webPush` code), so a list without it is shown without the row. The app owners drop the icon mapping and the test fixtures with it in their next build; no client has to ship before stage 2.
