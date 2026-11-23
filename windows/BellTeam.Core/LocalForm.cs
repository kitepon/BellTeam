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
    // Every Google client id of BellTeam (Web, iOS, Android, Desktop): the audiences a phone's token may carry.
    public static readonly string[] GoogleClientIds = new[] { "ld7o5f8j3smgqu2h1va43lt4au031s3i", "rmloup01smiuuv79m0tga49vtpobnsn4", "4ks1an9gat7npa9fdkok70kadrsp80rt", "7qi9ui73upodrlerlotlftk3vk82hprp", "be6dklphci1vbljimpg3ljpr5nc19cvv", "ktbg3e8931u0jv94c2fhccrig8ppau78", "lofu7qohq45fhbfup8k3ottlgat415pk" }
        .Select(id => "316260984663-" + id + ".apps.googleusercontent.com").ToArray();
    public const string GoogleDesktopClientId = "316260984663-rmloup01smiuuv79m0tga49vtpobnsn4.apps.googleusercontent.com";   // from Pinocchio (a540-google-clients)
    public const string PlayPublicKey = "MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEAri9WbSLPgiw3xak9MEg8udMt8egmWdY7T3gM15nxWWPLmdWp08NXaXmDgRcHobfYn003GlaGxCzeZZktrJjjQHM28gteK4p2qnSkuVVkF9N/JIgyubCw7MQtu+jrsg24leLUfGJfOTHB5BO1sxr8g+x3HeKCfAlISaj/XpN0p6e05/lIf/vcQoDV3e72Dd5WXcDdoM9M7YCXhPSUFZ5ydxZSCOc/N/0uAvhXey/kEFjBu8rpth+n/a3gFzNDayXMcUri2yKazEww9EfDGbKoUrXQNGJOV91vpH5SKOV4IfgnHsoglxWkFTerfVUgVqrTUhV2Nh8kMPyEw2RUj/ZWQwIDAQAB";   // Play Console license key, from Cielo (a540-play-license-key)
    public static bool DesktopReady => GoogleDesktopClientId.Length != 0 && PlayPublicKey.Length != 0;
    public static bool AndroidReady => PlayPublicKey.Length != 0;
}

// Provisional words (the contract fixes the meaning, not the Japanese): Tronie/Bready decide the final wording. The strings the contract quotes are in the comments.
public static class LocalFormText
{
    public const string Title = "スマホで確認する";
    // makeRequest: the QR is read by the paying phone, over the same local network.
    public const string Lead = "購読しているスマホのBellTeamで、このQRを読み取ってください。スマホとこのパソコンは、同じWi-Fiにつないでください。";
    public const string Google = "Googleでサインインして、スマホで確認する";
    public const string Apple = "iPhoneのAppleサインインで、スマホで確認する";
    public const string ApproveLead = "ログインしたい端末に出ているQRを読み取ってください。スマホとその端末は、同じWi-Fiにつないでください。";
    public const string Waiting = "スマホの返事を待っています…";
    public const string Window = "このQRは、このパソコンが待っている間だけ使えます（10分）。";
    public const string Cancel = "やめる";
    public const string NewQr = "新しいQRを出す";
    // The firewall's first prompt is the person's one step (contract s10, Windows).
    public const string Firewall = "Windowsのファイアウォールの確認が出たら、許可してください。";
    public const string PermissionDenied = "このアプリのローカルネットワークへのアクセスを、設定で許可してください。許可したあと、新しいQRを出してください。";
    public const string PeriodEnded = "購読の期間が終わりました。新しいQRで、もう一度スマホに確認してもらってください。";
    public static string Paid(DateTimeOffset until) => "購読を確認しました。" + SubscriptionText.ValidUntil(until);

    // "put both on the same Wi-Fi" / "..., marked as a private network" / "another account" / "no purchase" / a refused reply / the 10-minute end. Paid is spoken by Paid(until).
    public static string Of(LocalFormOutcome outcome) => outcome switch
    {
        LocalFormOutcome.SameWifi => "スマホとこのパソコンを、同じWi-Fiにつないでください。",
        LocalFormOutcome.PrivateNetwork => "スマホとこのパソコンを、同じWi-Fiにつないでください。このパソコンのWi-Fiは「プライベート ネットワーク」にしてください。",
        LocalFormOutcome.NoPurchase => "このスマホには購読がありません。購読しているスマホで読み取ってください。",
        LocalFormOutcome.AnotherAccount => "スマホは別のアカウントでサインインしています。このパソコンと同じアカウントのスマホで読み取ってください。",
        LocalFormOutcome.Refused => "スマホの返事を受け取れませんでした。新しいQRで、もう一度お試しください。",
        LocalFormOutcome.Ended => "QRの待ち時間（10分）が過ぎました。新しいQRを出してください。",
        LocalFormOutcome.LocalNetworkDenied => PermissionDenied,
        LocalFormOutcome.Lapsed => "スマホの購読は、期間が終わっています。購読を更新してから、新しいQRを出してください。",
        _ => throw new ArgumentOutOfRangeException(nameof(outcome), outcome, "Paid is shown with its end time: LocalFormText.Paid"),
    };

    // The library's error codes (docs/local-form.md) in this app's words; a code that is not a try's own outcome (sign-in, unreachable ...) keeps StoreAccountText's sentence. Every outcome here ends the try: the next step is a new QR.
    public static string Failure(string code, int? status = null) => code switch
    {
        "unreachable_same_wifi" => Of(LocalFormOutcome.SameWifi),
        "local_network_denied" => Of(LocalFormOutcome.LocalNetworkDenied),
        "not_paid" => Of(LocalFormOutcome.NoPurchase),
        "other_account" => Of(LocalFormOutcome.AnotherAccount),
        "request_expired" => Of(LocalFormOutcome.Ended),
        "ended" or "revoked" => Of(LocalFormOutcome.Lapsed),
        "request_gone" or "request_invalid" or "other_request" or "proof_invalid" or "not_this_app" or "product_unknown" or "sandbox_refused" or "sealed_invalid" or "connection_closed" or "device_refused" => Of(LocalFormOutcome.Refused),
        _ => StoreAccountText.Failure(code, status),
    };
}
