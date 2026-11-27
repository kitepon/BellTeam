# a540-sim-windows: Windows 0.9.3 device checks on fox (2026-11-27 JST, Anis)

Build under test: Windows 0.9.3+8003708b07d9901608aed8791ebc6fc8f88080ea (login-billing 0.24.1, Approval Box client 0.5.4) on the Owner's PC "fox" (Windows 11), installed copy %LOCALAPPDATA%\Programs\BellTeam\BellTeam.exe.
How it ran: the app was started in the interactive desktop session (session 2) by a scheduled task as `fox\kite_` with RunLevel Limited. Process token: Medium integrity, TokenElevation=0, i.e. **non-elevated**. State: `%LOCALAPPDATA%\BellTeam` and `BellTeam-ApprovalBox` were moved aside for a first-run state and moved back afterwards (the original files are restored, same timestamps). The sign-in browser was a separate test Chrome profile (`BELLTEAM_TEST_CHROME_PROFILE`) with the shared Google test account aria.cecil@gmail.com (never the Owner's account). The Owner's session had been idle for 34 hours; nobody was at the PC.

## 1. Google sign-in (desktop): PASS (09:05-09:06 JST)
First screen -> 「Googleでサインイン」 -> test Chrome (account page, password, consent) -> the local page 「The sign-in ended. Return to the app.」 -> the app showed 「使っている端末の承認を待っています」 with the QR and 「9:15 まで有効」.
Pictures: [1-google-sign-in-ended.png](1-google-sign-in-ended.png), [2-first-screen-qr-after-sign-in.png](2-first-screen-qr-after-sign-in.png).

## 2. Windows firewall prompt: NOT REPRODUCIBLE on fox (measured, cause inferred)
While the QR listener ran (BellTeam.exe listening on `:::55316`), **no Windows Security Alert appeared** and **no firewall rule for BellTeam exists** (active store, 0 filters). Windows Defender Firewall is on with inbound=Block on all profiles, and notify-on-listen is true; still Rapi's Mac (192.168.1.12) connected to fox:55316 three times (09:12:52, 09:13:19, 09:13:48, `nc -zv`, 3 of 3), and the Security log (audit "Filtering Platform Connection" switched on for the test, switched off again) recorded event 5156 (connection allowed) for BellTeam.exe for the first two. ICMP ping gets no reply.
Cause (inference, the single allowing filter was not identified): fox runs **ESET Security**: Windows Security Center lists "ESET ファイアウォール" as the firewall product, ekrn is running, and the WFP filter dump holds 45 ESET filters. So on this PC the Windows prompt cannot appear, and the traffic is decided by ESET. This also explains the 11/24 note "no rule, yet the parent reached the app".
What the app says on this screen is unchanged and worked as intended: 「Windowsのファイアウォールの確認が出たら、許可してください。」 and the security-software sentence (shot 2). A real prompt needs a Windows PC (or VM) without a third-party firewall.

## 3. QR shown on Windows, approved from a phone emulator: PASS with Neon's Android emulator (09:28 JST)
- iPhone simulator: cannot (Rapi measured on iPhone 17 Pro sim, iOS 26.5: the StoreKit sandbox purchase fails with akd -7005, so the sim never reaches a paid state; no approval is possible from a simulator).
- Android emulator (Neon, Android 0.1.33, Play test purchase active, same account): the Windows QR link was opened by the emulator, 「別の端末を承認しますか」 -> 承認 at 09:28. Fox then left the QR screen and showed 「BellTeamの購読 有効 / 購読中です。（2026年12月28日 9:28まで） / 購読を確認しました。」 and 「サーバーにつなぐ」 (fox 192.168.1.11:49850 reached over the LAN).
Pictures: [4-first-screen-qr-sent-to-neon.png](4-first-screen-qr-sent-to-neon.png), [5-approved-by-android-emulator-subscribed.png](5-approved-by-android-emulator-subscribed.png). Phone side (Neon, host rabbit): /home/kite/BellTeam-a540-sim/shots/40-win-asking.png and 41-win-approved.png.

## 4. 決裁箱 child join with a test parent: PASS twice (09:35 and 09:41 JST)
Parent: Indivilia's Approval Box Android emulator (vc42, host rabbit), signed in with the same test account (task approval-box/kansei-20261124/k21-test-parent). Order that the app forces: after step 3 the app goes to the server screen (http://192.168.1.2:18891/), then the 決裁箱 window offers 「決裁箱につなぎます」 -> Google sign-in -> QR 「決裁箱の承認を待っています」 (valid 10 min) -> link sent to the parent.
- Join 1: link sent 09:35:18, fox wrote its `approval-box-child\joined` marker at 09:35:39, the window left the QR and showed the Live 決裁箱 view; panel text 「決裁箱につながっています」. Parent's phone showed "Could not approve. Please try again." after Allow, with no login-billing failure line in its log (a parent-side item Indivilia keeps open; the join itself completed).
- Join 2 (after 「決裁箱へのつなぎを外す」): joined marker 09:41:08; Indivilia's tcpdump shows the phone's reply (about 1590 B) at 09:41:08.494 and fox's taken frame (52 B) within 1 ms; no error on the phone this time.
Pictures: [7-child-join-qr.png](7-child-join-qr.png), [8-child-join-live-view.png](8-child-join-live-view.png), [9-child-joined-panel.png](9-child-joined-panel.png) (this panel is still the 0.9.3 wording 「AIの許可待ちを決裁箱へ送る」; the new 「決裁箱につなぐ」 view of #2650 ships in the next build). Phone side (Indivilia, rabbit): /home/kite/k21/shots/ (anis-1-confirm.png, anis-2-after-allow.png, repro-*.png, repro-tcpdump.txt).
After the checks the child left through 「決裁箱へのつなぎを外す」 so no stale child stays in the account.

## Found and fixed in this PR
The child join's Google sign-in ignored `BELLTEAM_TEST_CHROME_PROFILE` and opened the **default browser** (here: the Owner's Chrome with his account list). Only the two older call sites used the test browser. `ApprovalBoxDevice`'s public constructor now passes `TestBrowser.Open` (null unless the variable is set, so users see no change). The two stray sign-in tabs this left in the Owner's Chrome were closed again.

## What a simulator/emulator cannot show
- The Windows Security Alert itself (needs a Windows PC/VM without ESET or another third-party firewall).
- An iPhone-sourced approval (needs a real paid iPhone: StoreKit sandbox sign-in fails in the simulator).
- A phone camera reading a QR on a physical screen (the Android emulator opened the link directly, as App Link).
