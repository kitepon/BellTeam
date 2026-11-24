using System.Windows;
using System.Windows.Controls;
using BellTeam.App;
using BellTeam.Core;

namespace BellTeam.Tests;

// a540: Rapi's table word for word (Tronie 2026-11-23: one spec on every platform, the Mac app is the reference), the period rule, and the section of the local form.
public sealed class LocalFormTests
{
    [Fact]
    public void TheWantingDeviceWordsAreRapisTableWordForWord()
    {
        Assert.Equal(("BellTeamの購読", "購読はまだありません。", "購読しているスマホで確認する", "QRを出す（Google）", "QRを出す（Apple）", "確認用のQRコード", "やめる", "購読を確認しました。"),
            (LocalFormText.CardTitle, LocalFormText.StatusUnpaid, LocalFormText.Title, LocalFormText.Google, LocalFormText.Apple, LocalFormText.QrLabel, LocalFormText.Cancel, LocalFormText.PaidOk));
        Assert.Equal("この端末にQRを出します。2台は同じネットワーク（同じLAN）につないでください。", LocalFormText.Lead);
        Assert.Equal("購読の期間が終わっています。新しいQRを出してください。", LocalFormText.PeriodEnded);
        Assert.Equal("購読中です。", LocalFormText.Status(null));
        var end = new DateTimeOffset(2026, 12, 23, 12, 0, 0, TimeSpan.Zero);
        Assert.Equal("購読中です。（" + end.ToLocalTime().ToString("yyyy年M月d日 H:mm") + "まで）", LocalFormText.Status(end));
        Assert.Equal("スマホの返事を待っています（" + end.ToLocalTime().ToString("H:mm") + "まで）", LocalFormText.WaitingUntil(end));
    }

    [Fact]
    public void EveryFailureLineIsTheTablesByLibraryCodeAndAnUnknownCodeSaysItself()
    {
        Assert.Equal("スマホからこの端末に届きませんでした。2台を同じネットワーク（同じLAN）につないでから、もう一度お試しください。", LocalFormText.Failure("unreachable_same_wifi"));
        Assert.Equal("設定でこのアプリのローカルネットワークを許可してから、新しいQRでお試しください。", LocalFormText.Failure("local_network_denied"));
        Assert.Equal("QRが正しくありません。相手の画面で新しいQRを出してください。", LocalFormText.Failure("qr_invalid"));
        Assert.All(new[] { "request_invalid", "other_request" }, code => Assert.Equal(LocalFormText.OutdatedPeer, LocalFormText.Failure(code)));
        Assert.Equal("別のアカウントです。相手の端末と同じアカウントでサインインしてください。", LocalFormText.Failure("other_account"));
        Assert.All(new[] { "request_expired", "request_gone" }, code => Assert.Equal("QRの待ち時間（10分）が過ぎました。新しいQRを出してください。", LocalFormText.Failure(code)));
        Assert.Equal("相手が返事を受け取りませんでした。相手の画面で新しいQRを出してください。", LocalFormText.Failure("device_refused"));
        Assert.All(new[] { "purchase_failed", "purchase_unverified" }, code => Assert.Equal("購入を完了できませんでした。もう一度お試しください。", LocalFormText.Failure(code)));
        Assert.Equal("相手との接続が途中で切れました。新しいQRでもう一度お試しください。", LocalFormText.Failure("connection_closed"));
        Assert.Equal("購読の期間が終わっています。新しいQRを出してください。", LocalFormText.Failure("ended"));
        Assert.All(new[] { "not_paid", "revoked", "proof_invalid", "not_this_app", "product_unknown", "sandbox_refused" }, code => Assert.Equal("購入を確かめられませんでした（" + code + "）。", LocalFormText.Failure(code)));
        Assert.All(new[] { "bad_request", "provider_unsupported" }, code => Assert.Equal("この端末ではそのアカウントでサインインできません。", LocalFormText.Failure(code)));
        Assert.Equal("つながりません。ネットワークを確かめて、もう一度お試しください。", LocalFormText.Failure("network"));
        Assert.Equal("処理できませんでした（brand_new_code）。", LocalFormText.Failure("brand_new_code"));
        Assert.Equal("その端末には購読がありません。購読している端末で読み取ってください。", LocalFormText.Of(LocalFormOutcome.NoPurchase));
        Assert.Contains("プライベート ネットワーク", LocalFormText.Of(LocalFormOutcome.PrivateNetwork)); Assert.DoesNotContain("プライベート", LocalFormText.Of(LocalFormOutcome.SameWifi));   // the one Windows/Linux deviation
        Assert.Throws<ArgumentOutOfRangeException>(() => LocalFormText.Of(LocalFormOutcome.Paid));
    }

    [Fact]
    public void TheApprovingPhoneWordsAreRapisTableWordForWord()
    {
        Assert.Equal(("別の端末を承認する", "QRを読み取る", "QRを読み取る", "閉じる", "別の端末を承認しますか", "承認", "やめる", "確認の返事を送りました。", "この端末には購読がありません。先に購読してください。"),
            (StoreAccountText.ApproveTitle, StoreAccountText.ApproveScan, StoreAccountText.ApproveScannerTitle, StoreAccountText.ApproveClose, StoreAccountText.ApproveConfirmAsk, StoreAccountText.ApproveYes, StoreAccountText.ApproveNo, StoreAccountText.ApprovedLine, StoreAccountText.ApproveNoPurchase));
        Assert.Equal("承認したい端末に出ているQRを読み取ります。自分で始めたものだけ承認してください。2台は同じネットワーク（同じLAN）につないでください。", LocalFormText.ApproveLead);
        Assert.Equal("この端末の購読の証明を、読み取ったQRの端末へ送ります。その端末が目の前にあり、自分で始めたものだけ承認してください。", StoreAccountText.ApproveOwnLine);
    }

    // Tronie 2026-11-23: the accepted audiences list every BellTeam Google client id (Pinocchio, a540-google-clients: iOS, Desktop, Android upload / Play signing / debug, web serverClientId, sign-in web) and Apple's own, the app id and (contract 1.46) the Services ID of the PC's own Apple sign-in.
    [Fact]
    public void TheAcceptedAudiencesListEveryBellTeamGoogleClientIdAndTheAppleAppId()
    {
        var audiences = LocalFormConfig.Build().Audiences;
        foreach (var id in new[] { "ld7o5f8j3smgqu2h1va43lt4au031s3i", "rmloup01smiuuv79m0tga49vtpobnsn4", "4ks1an9gat7npa9fdkok70kadrsp80rt", "7qi9ui73upodrlerlotlftk3vk82hprp", "be6dklphci1vbljimpg3ljpr5nc19cvv", "ktbg3e8931u0jv94c2fhccrig8ppau78", "lofu7qohq45fhbfup8k3ottlgat415pk" })
            Assert.Contains("316260984663-" + id + ".apps.googleusercontent.com", audiences);
        Assert.Contains("dev.kitepon.bellbot", audiences); Assert.Contains("dev.kitepon.bellbot.signin", audiences); Assert.Equal(9, audiences.Count); Assert.Contains(LocalFormIds.GoogleDesktopClientId, audiences);
    }

    [Fact]
    public void ANewQrIsNeededWhenNoPeriodWasAcceptedOrItHasEnded()
    {
        var now = new DateTimeOffset(2026, 11, 23, 12, 0, 0, TimeSpan.Zero);
        Assert.True(LocalForm.NeedsNewRequest(null, now)); Assert.True(LocalForm.NeedsNewRequest(now, now));
        Assert.False(LocalForm.NeedsNewRequest(now.AddSeconds(1), now));
    }

    [Fact]
    public void TheSectionOffersTheButtonShowsTheQrWithItsLabelAndTheExpiryAndShowsWhatTheLastTryEndedWith() => RunSta(() =>
    {
        var started = new List<string>(); var stopped = 0; var view = new LocalRequestView(started.Add, () => stopped++);
        var expiry = new DateTimeOffset(2026, 11, 23, 12, 10, 0, TimeSpan.Zero);
        view.ShowIdle();
        Assert.Contains(LocalFormText.Title, Texts(view)); Assert.Contains(LocalFormText.Lead, Texts(view)); Assert.Empty(Descendants<QrView>(view));
        Assert.Equal([LocalFormText.Apple, LocalFormText.Google], Descendants<Button>(view).Select(b => System.Windows.Automation.AutomationProperties.GetName(b)));   // Apple first, as the Mac app
        Click(view, LocalFormText.Apple); Click(view, LocalFormText.Google); Assert.Equal(["apple", "google"], started);
        view.ShowRequest("QR-TEXT", expiry);
        Assert.Equal(LocalFormText.QrLabel, System.Windows.Automation.AutomationProperties.GetName(Descendants<QrView>(view).Single()));
        Assert.Contains(LocalFormText.WaitingUntil(expiry), Texts(view)); Assert.Contains(LocalFormText.Firewall, Texts(view));
        Click(view, LocalFormText.Cancel); Assert.Equal(1, stopped);
        view.ShowIdle(LocalFormText.Failure("other_account"));
        Assert.Contains(LocalFormText.Failure("other_account"), Texts(view)); Assert.Empty(Descendants<QrView>(view)); Click(view, LocalFormText.Google); Assert.Equal(["apple", "google", "google"], started);
    });

    // The fox sitting: a Public network drops the phone's reply, so the wait says what to change; the security-software line is always there. IsPublic must agree with Windows' own profile.
    [Fact]
    public void TheQrWaitSaysWhatToChangeWhenTheNetworkIsPublic() => RunSta(() =>
    {
        var view = new LocalRequestView(_ => { }, () => { }); view.ShowRequest("QR-TEXT", DateTimeOffset.Now.AddMinutes(10));
        var texts = Texts(view);
        Assert.Contains(LocalFormText.Blocked, texts); Assert.Contains(LocalFormText.Firewall, texts);
        Assert.Equal(NetworkNotes.IsPublic(), texts.Contains(LocalFormText.PublicNetwork));
    });

    private static string[] Texts(DependencyObject root) => Descendants<TextBlock>(root).Select(text => text.Text).ToArray();
    private static void Click(DependencyObject root, string name) => Descendants<Button>(root).Single(button => System.Windows.Automation.AutomationProperties.GetName(button) == name).RaiseEvent(new RoutedEventArgs(Button.ClickEvent));
    private static IEnumerable<T> Descendants<T>(DependencyObject root) where T : DependencyObject { if (root is T found) yield return found; foreach (var child in LogicalTreeHelper.GetChildren(root).OfType<DependencyObject>()) foreach (var item in Descendants<T>(child)) yield return item; }
    private static void RunSta(Action action)
    {
        Exception? error = null; var thread = new Thread(() => { try { action(); } catch (Exception e) { error = e; } }); thread.SetApartmentState(ApartmentState.STA); thread.Start(); thread.Join();
        if (error is not null) throw new Exception(error.Message, error);
    }

    // Contract 1.50 (the Owner): BellTeam's own first sign-in guidance stands before the Apple / Google buttons, word for word, in the card and not after the QR is made.
    [Fact]
    public void TheFirstSignInGuidanceStandsBeforeTheTwoButtons() => RunSta(() =>
    {
        Assert.Equal("本アプリケーションを使用するには、iPhone、iPad、Mac、Android等の購読済みの端末で、サインイン後に表示されるQRコードを読み取る必要があります。", LocalFormText.FirstSignInChildOnly);   // Windows cannot become a parent: the child-only lead, word for word
        var view = new LocalRequestView(_ => { }, () => { }); view.ShowIdle();
        var texts = Descendants<TextBlock>(view).Select(text => text.Text).ToList();
        Assert.True(texts.IndexOf(LocalFormText.Lead) < texts.IndexOf(LocalFormText.FirstSignInChildOnly), "below the lead");
        var children = view.Children.Cast<UIElement>().ToList();
        var guidance = children.IndexOf(children.OfType<TextBlock>().Single(text => text.Text == LocalFormText.FirstSignInChildOnly));
        var buttons = children.FindIndex(child => child is WrapPanel);
        Assert.True(guidance >= 0 && guidance < buttons, "before the Apple / Google buttons");
    });

    // Contract 1.49 (Mint, Tronie 2026-11-24): the QR is the library's join link of BellTeam's app id, and the library's guidance stands word for word beside it.
    [Fact]
    public void ATestPurchaseOnThePayingPhoneIsTaken() => Assert.True(LocalFormConfig.Build().Apple!.Sandbox);

    [Fact]
    public void TheAppIdIsBellTeamsAndTheGuidanceStandsBesideTheQr() => RunSta(() =>
    {
        Assert.Equal("dev.kitepon.bellbot", LocalFormConfig.Build().AppId);
        var link = "https://login-billing.kitepon.dev/join/dev.kitepon.bellbot#lbq4:" + new string('A', 170);
        var view = new LocalRequestView(_ => { }, () => { }); view.ShowRequest(link, DateTimeOffset.Now.AddMinutes(10));
        Assert.Contains("親となる端末（課金操作をするカメラのあるスマートフォンがお勧め）のカメラでQRコードを読んでください。", Texts(view));
        Assert.Equal("親となる端末（課金操作をするカメラのあるスマートフォンがお勧め）のカメラでQRコードを読んでください。", LocalFormText.Qr);
        Assert.Contains(Descendants<TextBlock>(view), text => System.Windows.Automation.AutomationProperties.GetAutomationId(text) == "local-request-guidance" && text.Text == LocalFormText.Qr);
        var qr = Assert.Single(Descendants<QrView>(view));                                                // beside the guidance, in one row
        using var data = new QRCoder.QRCodeGenerator().CreateQrCode(link, QRCoder.QRCodeGenerator.ECCLevel.M);
        var cell = qr.Width / data.ModuleMatrix.Count;
        Assert.Equal(Math.Round(cell), cell); Assert.True(cell >= 3 && qr.Width is >= 260 and <= 300, "whole-pixel modules of about 280 px: a phone camera reads sharp squares from a screen");
    });
}
