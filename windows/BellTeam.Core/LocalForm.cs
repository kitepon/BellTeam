namespace BellTeam.Core;

// a540 (login-billing contract 1.36 s10, "The local form"): what one request of the wanting device can end in. The library's own result type maps onto this (Purika's names come with t10b); only these words reach the person.
public enum LocalFormOutcome { Paid, NoPurchase, AnotherAccount, SameWifi, PrivateNetwork, Refused, Ended, LocalNetworkDenied, Lapsed }

public static class LocalForm
{
    // The listener of one request closes after this long (contract s10); the person then asks for a new QR.
    public const int ListenMinutes = 10;
    // A device's own clock decides when a period ends (contract s10, limits); without an accepted period there is nothing to renew from, so the next step is a QR too.
    public static bool NeedsNewRequest(DateTimeOffset? paidUntil, DateTimeOffset now) => paidUntil is not { } until || until <= now;
}

// What a BellTeam build knows of its own store and Google clients (public ids from Pinocchio and Cielo). A part shows "not configured" instead of a QR while one it needs is empty.
// Open: Google's Desktop client also wants its client secret at the token exchange (library contract 1.37, Purika t10e). GitHub's push protection refuses the secret in a commit, so it is not here yet; Tronie rules how it reaches the build.
public static class LocalFormIds
{
    public const string AppleBundleId = "dev.kitepon.bellbot", ProductId = "dev.kitepon.bellbot.monthly", PlayPackage = "dev.kitepon.bellbot";
    // Apple's web sign-in of a device that is not Apple's (library contract 1.46): BellTeam's Services ID and the library's return page registered on it (Tronie/Mint 2026-11-24).
    public const string AppleServicesId = "dev.kitepon.bellbot.signin", AppleReturnUrl = "https://login-billing.kitepon.dev/apple-return";
    // Every Google client id of BellTeam (Web, iOS, Android, Desktop): the audiences a phone's token may carry.
    public static readonly string[] GoogleClientIds = new[] { "ld7o5f8j3smgqu2h1va43lt4au031s3i", "rmloup01smiuuv79m0tga49vtpobnsn4", "4ks1an9gat7npa9fdkok70kadrsp80rt", "7qi9ui73upodrlerlotlftk3vk82hprp", "be6dklphci1vbljimpg3ljpr5nc19cvv", "ktbg3e8931u0jv94c2fhccrig8ppau78", "lofu7qohq45fhbfup8k3ottlgat415pk" }
        .Select(id => "316260984663-" + id + ".apps.googleusercontent.com").ToArray();
    public const string GoogleDesktopClientId = "316260984663-rmloup01smiuuv79m0tga49vtpobnsn4.apps.googleusercontent.com";   // from Pinocchio (a540-google-clients)
    public const string PlayPublicKey = "MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEAri9WbSLPgiw3xak9MEg8udMt8egmWdY7T3gM15nxWWPLmdWp08NXaXmDgRcHobfYn003GlaGxCzeZZktrJjjQHM28gteK4p2qnSkuVVkF9N/JIgyubCw7MQtu+jrsg24leLUfGJfOTHB5BO1sxr8g+x3HeKCfAlISaj/XpN0p6e05/lIf/vcQoDV3e72Dd5WXcDdoM9M7YCXhPSUFZ5ydxZSCOc/N/0uAvhXey/kEFjBu8rpth+n/a3gFzNDayXMcUri2yKazEww9EfDGbKoUrXQNGJOV91vpH5SKOV4IfgnHsoglxWkFTerfVUgVqrTUhV2Nh8kMPyEw2RUj/ZWQwIDAQAB";   // Play Console license key, from Cielo (a540-play-license-key)
    public static bool DesktopReady => GoogleDesktopClientId.Length != 0 && PlayPublicKey.Length != 0;
    public static bool AndroidReady => PlayPublicKey.Length != 0;
}

// The words of the local form: Rapi's final table (Tronie 2026-11-23: one spec on every platform, the Mac app is the reference), word for word. Where the paying phone may be an Android, the word is スマホ.
// The one deviation: Windows/Linux name the private-network step (PrivateNetwork), which the contract asks of a PC whose Wi-Fi is marked Public.
public static class LocalFormText
{
    public const string CardTitle = "BellTeamの購読";
    public const string StatusUnpaid = "購読はまだありません。";
    // "購読中です。（{date time}まで）"; no "（…）" when the purchase has no end date.
    public static string Status(DateTimeOffset? until) => until is { } end ? "購読中です。（" + End(end) + "まで）" : "購読中です。";
    // Kept for the cards that show the paid line: it is the status line of the table.
    public static string Paid(DateTimeOffset until) => Status(until);
    public const string PaidOk = "購読を確認しました。";
    public const string Title = "購読しているスマホで確認する";
    public const string Lead = "この端末にQRを出します。2台は同じWi-Fiにつないでください。";
    public const string Google = "QRを出す（Google）";
    public const string Apple = "QRを出す（Apple）";
    public const string QrLabel = "確認用のQRコード";
    public const string Waiting = "スマホの返事を待っています";
    // time = when the QR stops being taken (10 minutes after it was shown).
    public static string WaitingUntil(DateTimeOffset expiry) => "スマホの返事を待っています（" + expiry.ToLocalTime().ToString("H:mm") + "まで）";
    public const string Cancel = "やめる";
    public const string PeriodEnded = "購読の期間が終わっています。新しいQRを出してください。";
    // Not in the table: the cards of Linux/Android show them today; Windows' firewall step is the contract's (Windows, first listen).
    public const string Window = "このQRは、このパソコンが待っている間だけ使えます（10分）。";
    public const string NewQr = "新しいQRを出す";
    public const string Firewall = "Windowsのファイアウォールの確認が出たら、許可してください。";
    // BellTeam's own guidance (the Owner, contract 1.50: 0.22.1 removed the library's LocalGuidance), word for word on every client. FirstSignIn: on the first sign-in screen, before the Apple / Google buttons. Qr: beside the local form's QR.
    public const string FirstSignIn = "すでにほかの端末で使っている方は、同じアカウントでサインインしてから、次に出るQRコードを使用中の端末のカメラで読んでください。";
    public const string Qr = "親となる端末（課金操作をするカメラのあるスマートフォンがお勧め）のカメラでQRコードを読んでください。";
    public const string OutdatedPeer = "QRが正しくないか、相手の端末のBellTeamが古い可能性があります。2台とも最新版に更新してから、相手の画面で新しいQRを出してください。";
    public const string PermissionDenied = "設定でこのアプリのローカルネットワークを許可してから、新しいQRでお試しください。";
    public const string ApproveLead = "承認したい端末に出ているQRを読み取ります。自分で始めたものだけ承認してください。2台は同じWi-Fiにつないでください。";
    private static string End(DateTimeOffset end) => end.ToLocalTime().ToString("yyyy年M月d日 H:mm");

    // The outcomes of a try in the table's sentences. Paid is spoken by Status / PaidOk.
    public static string Of(LocalFormOutcome outcome) => outcome switch
    {
        LocalFormOutcome.SameWifi => "スマホとこの端末を、同じWi-Fiにつないでください。",
        LocalFormOutcome.PrivateNetwork => "スマホとこの端末を、同じWi-Fiにつないでください。このパソコンのWi-Fiは「プライベート ネットワーク」にしてください。",
        LocalFormOutcome.NoPurchase => "その端末には購読がありません。購読している端末で読み取ってください。",
        LocalFormOutcome.AnotherAccount => "別のアカウントです。相手の端末と同じアカウントでサインインしてください。",
        LocalFormOutcome.Refused => "QRが正しくありません。相手の画面で新しいQRを出してください。",
        LocalFormOutcome.Ended => "QRの待ち時間（10分）が過ぎました。新しいQRを出してください。",
        LocalFormOutcome.LocalNetworkDenied => PermissionDenied,
        LocalFormOutcome.Lapsed => PeriodEnded,
        _ => throw new ArgumentOutOfRangeException(nameof(outcome), outcome, "Paid is spoken by Status / PaidOk"),
    };

    // The failure lines by the library's error code (docs/local-form.md), the table's, shown in red under the card. status is unused (kept for the callers that pass the library's); detail is the library's Detail (Apple's own error word for signin_failed, never a token).
    public static string Failure(string code, int? status = null, string? detail = null) => code switch
    {
        "unreachable_same_wifi" => Of(LocalFormOutcome.SameWifi),
        "local_network_denied" => PermissionDenied,
        "qr_invalid" => Of(LocalFormOutcome.Refused),
        // 0.21.1 changed the QR hash and the add's nonce: a 0.21.0 (or older) device against a 0.21.1 one ends here, so the person is told to update both.
        "request_invalid" or "other_request" => OutdatedPeer,
        "other_account" => Of(LocalFormOutcome.AnotherAccount),
        "request_expired" or "request_gone" => Of(LocalFormOutcome.Ended),
        "device_refused" => "相手が返事を受け取りませんでした。相手の画面で新しいQRを出してください。",
        "connection_closed" => "相手との接続が途中で切れました。新しいQRでもう一度お試しください。",
        "ended" => PeriodEnded,
        "purchase_failed" or "purchase_unverified" => "購入を完了できませんでした。もう一度お試しください。",   // the Apple app's sentence (LocalAccount.words), no code
        "not_paid" or "revoked" or "proof_invalid" or "not_this_app" or "product_unknown" or "sandbox_refused" => "購入を確かめられませんでした（" + code + "）。",
        "bad_request" or "provider_unsupported" => "この端末ではそのアカウントでサインインできません。",
        "network" or "unreachable" => "つながりません。ネットワークを確かめて、もう一度お試しください。",
        "signin_required" => "サインインしてから、もう一度お試しください。",
        "return_not_received" => "サインインの結果が戻ってきませんでした。もう一度お試しください。",
        "signin_failed" => detail is { Length: > 0 } why ? "サインインできませんでした（" + why + "）。" : "サインインできませんでした。もう一度お試しください。",
        _ => "処理できませんでした（" + code + "）。",
    };
}
