# Windows通知の仕様と実測

取得日: 2026-10-13。出典: Microsoftのデスクトップ通知手順、ToastNotification.SuppressPopup、The Old New Thing、WindowsAppSDKのissue。確度: API契約は一次資料、非表示の要求と履歴取得はFOXで実測、ポップアップとクリックは未確認。

- [デスクトップ通知](https://learn.microsoft.com/en-us/windows/win32/shell/quickstart-sending-desktop-toast)は、スタートメニューのショートカットへAppUserModelIDを付け、CreateToastNotifierへ渡す。Activated・Dismissed・Failedを使う。BellTeamは起動中だけの通知なので、終了後に起こすCOM activatorは登録しない。
- [SuppressPopup](https://learn.microsoft.com/en-us/uwp/api/windows.ui.notifications.toastnotification.suppresspopup)をtrueにすると、画面にポップアップを出さず通知センターへ置ける。非表示試験は無音のaudioと合わせる。
- [The Old New Thing](https://devblogs.microsoft.com/oldnewthing/20200810-00/?p=104058)は、登録が完成していないアプリでToastNotifier.Settingが例外になり得ると説明する。初回通知より前のSetting読取を有効化の関所にしてはいけない。FOXでは0x80070490を再現し、事前読取を外した正式な通知要求から履歴1件を読めた。
- Windows App SDKの自己完結配布は、[issue 6774](https://github.com/microsoft/WindowsAppSDK/issues/6774)と[6387](https://github.com/microsoft/WindowsAppSDK/issues/6387)にあるInsights.Resource.dll欠落がFOXでも再現した。RegisterとUnregisterAllは0x8007007E。SDK/RuntimeのNuGet参照を足しても自己完結の出力に必要な部品が無く、Windows組込APIへ実装を置き換えた。失敗時の別経路へ分岐する実装は持たない。

実測と未確認は[前面確認と通知の記録](../../docs/windows-final-check.md)に残す。
