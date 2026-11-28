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
    // Test purchases (TestFlight / App Review) are Apple Sandbox transactions; every BellTeam client takes them (Owner 2026-11-24, after fox refused iPhone 199 with sandbox_refused). Play license-test purchases carry no such flag in the library: Play's own signature check takes them.
    public const bool AppleAcceptsSandbox = true;
    public const string AppleBundleId = "dev.kitepon.bellbot";
    public const string ProductId = "dev.kitepon.bellbot.monthly";
    public const string PlayPackage = "dev.kitepon.bellbot";
    // Apple's web sign-in of a device that is not Apple's (library contract 1.46): BellTeam's Services ID and the library's return page registered on it (Tronie/Mint 2026-11-24).
    public const string AppleServicesId = "dev.kitepon.bellbot.signin";
        public const string AppleReturnUrl = "https://login-billing.kitepon.dev/apple-return";
    // Every Google client id of BellTeam (Web, iOS, Android, Desktop): the audiences a phone's token may carry.
    public static readonly string[] GoogleClientIds = new[] { "ld7o5f8j3smgqu2h1va43lt4au031s3i", "rmloup01smiuuv79m0tga49vtpobnsn4", "4ks1an9gat7npa9fdkok70kadrsp80rt", "7qi9ui73upodrlerlotlftk3vk82hprp", "be6dklphci1vbljimpg3ljpr5nc19cvv", "ktbg3e8931u0jv94c2fhccrig8ppau78", "lofu7qohq45fhbfup8k3ottlgat415pk" }
        .Select(id => "316260984663-" + id + ".apps.googleusercontent.com").ToArray();
    public const string GoogleDesktopClientId = "316260984663-rmloup01smiuuv79m0tga49vtpobnsn4.apps.googleusercontent.com";   // from Pinocchio (a540-google-clients)
    public const string PlayPublicKey = "MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEAri9WbSLPgiw3xak9MEg8udMt8egmWdY7T3gM15nxWWPLmdWp08NXaXmDgRcHobfYn003GlaGxCzeZZktrJjjQHM28gteK4p2qnSkuVVkF9N/JIgyubCw7MQtu+jrsg24leLUfGJfOTHB5BO1sxr8g+x3HeKCfAlISaj/XpN0p6e05/lIf/vcQoDV3e72Dd5WXcDdoM9M7YCXhPSUFZ5ydxZSCOc/N/0uAvhXey/kEFjBu8rpth+n/a3gFzNDayXMcUri2yKazEww9EfDGbKoUrXQNGJOV91vpH5SKOV4IfgnHsoglxWkFTerfVUgVqrTUhV2Nh8kMPyEw2RUj/ZWQwIDAQAB";   // Play Console license key, from Cielo (a540-play-license-key)
    public static bool DesktopReady => GoogleDesktopClientId.Length != 0 && PlayPublicKey.Length != 0;
    public static bool AndroidReady => PlayPublicKey.Length != 0;
}

// The words of the local form: Rapi's final table (Tronie 2026-11-23: one spec on every platform, the Mac app is the reference), word for word. Where the paying phone may be an Android, the word is スマホ.
// The one deviation: Windows/Linux name the private-network step (PrivateNetwork), which the contract asks of a PC whose network is marked Public. Never 「同じWi-Fi」: a wired PC on the same LAN qualifies (the Owner, contract 11.12).
public static class LocalFormText
{
    public static string CardTitle  => CoreStrings.LocalForm_CardTitle_1;
    public static string StatusUnpaid  => CoreStrings.LocalForm_StatusUnpaid_1;
    // "購読中です。（{date time}まで）"; no "（…）" when the purchase has no end date.
    public static string Status(DateTimeOffset? until) => until is { } end ? CoreStrings.LocalForm_Status_1(End(end)) : CoreStrings.LocalForm_Status_2;
    // Kept for the cards that show the paid line: it is the status line of the table.
    public static string Paid(DateTimeOffset until) => Status(until);
    public static string PaidOk  => CoreStrings.LocalForm_PaidOk_1;
    public static string Title  => CoreStrings.LocalForm_Title_1;
    public static string Lead  => CoreStrings.LocalForm_Lead_1;
    public static string Google  => CoreStrings.LocalForm_Google_1;
    public static string Apple  => CoreStrings.LocalForm_Apple_1;
    public static string QrLabel  => CoreStrings.LocalForm_QrLabel_1;
    public static string Waiting  => CoreStrings.LocalForm_Waiting_1;
    // time = when the QR stops being taken (10 minutes after it was shown).
    public static string WaitingUntil(DateTimeOffset expiry) => CoreStrings.LocalForm_WaitingUntil_1(expiry.ToLocalTime().ToString(CoreStrings.Pattern_Time));
    public static string Cancel  => CoreStrings.AccountDeletionText_ConfirmNo_1;
    public static string PeriodEnded  => CoreStrings.LocalForm_PeriodEnded_1;
    // Not in the table: the cards of Linux/Android show them today; Windows' firewall step is the contract's (Windows, first listen).
    public static string Window  => CoreStrings.LocalForm_Window_1;
    public static string NewQr  => CoreStrings.LocalForm_NewQr_1;
    public static string Firewall  => CoreStrings.LocalForm_Firewall_1;
    // Shown under the QR while the PC waits for the phone's reply (Owner's fox with ESET, 2026-11-24): what to change when the answer never arrives. PublicNetwork only when Windows classes the connected network Public.
    public static string PublicNetwork  => CoreStrings.LocalForm_PublicNetwork_1;
    public static string Blocked  => CoreStrings.LocalForm_Blocked_1;
    // BellTeam's own guidance (the Owner, contract 1.50: 0.22.1 removed the library's LocalGuidance), word for word on every client. FirstSignIn: on the first sign-in screen, before the Apple / Google buttons. Qr: beside the local form's QR.
    // The first screen (the Owner 2026-11-24: the parent-approval process on the first screen, 決裁箱 0.2.2 as the model): the app's name, one line of purpose, then the sign-in; after sign-in on a device not yet approved, this title over the QR with its validity.
    public const string AppName = "BellTeam";
            public static string Purpose  => CoreStrings.LocalForm_Purpose_1;
            public static string WaitingTitle  => CoreStrings.LocalForm_WaitingTitle_1;
    public static string ValidUntil(DateTimeOffset expiry) => CoreStrings.LocalForm_ValidUntil_1(expiry.ToLocalTime().ToString(CoreStrings.Pattern_Time));
    public static string FirstSignIn  => CoreStrings.LocalForm_FirstSignIn_1;
    // Devices that cannot become a parent (Windows and Linux only; the Owner 2026-11-24): the lead above the sign-in buttons. iPhone, Mac and Android keep FirstSignIn.
    public static string FirstSignInChildOnly  => CoreStrings.LocalForm_FirstSignInChildOnly_1;
    public static string Qr  => CoreStrings.LocalForm_Qr_1;
    // login-billing 1.60 (Owner 2026-11-27, K-A9DW3Q): the join code beside the QR, to see and copy (it holds an identity token, so it is pasted, not typed), and the words around the return link of a phone that could not reach this device.
    public static string CodeLabel  => CoreStrings.ChildJoin_CodeLabel_1;
        public static string CodeCopy  => CoreStrings.ChildJoin_CopyCode_1;
        public static string CodeCopied  => CoreStrings.LocalForm_CodeCopied_1;
    public static string CodeHint  => CoreStrings.LocalForm_CodeHint_1;
    public static string PasteLabel  => CoreStrings.LocalForm_PasteLabel_1;
    public static string PasteUse  => CoreStrings.LocalForm_PasteUse_1;
    public static string ReturnLead  => CoreStrings.LocalForm_ReturnLead_1;
    public static string ReturnOpen  => CoreStrings.LocalForm_ReturnOpen_1;
    public static string ReturnCopy  => CoreStrings.LocalForm_ReturnCopy_1;
    public static string OutdatedPeer  => CoreStrings.LocalForm_OutdatedPeer_1;
    public static string PermissionDenied  => CoreStrings.LocalForm_PermissionDenied_1;
    public static string ApproveLead  => CoreStrings.LocalForm_ApproveLead_1;
    private static string End(DateTimeOffset end) => end.ToLocalTime().ToString(CoreStrings.GoalModels_Date_1);

    // The outcomes of a try in the table's sentences. Paid is spoken by Status / PaidOk.
    public static string Of(LocalFormOutcome outcome) => outcome switch
    {
        LocalFormOutcome.SameWifi => CoreStrings.LocalForm_Of_1,
        LocalFormOutcome.PrivateNetwork => CoreStrings.LocalForm_Of_2,
        LocalFormOutcome.NoPurchase => CoreStrings.LocalForm_Of_3,
        LocalFormOutcome.AnotherAccount => CoreStrings.LocalForm_Of_4,
        LocalFormOutcome.Refused => CoreStrings.LocalForm_Of_5,
        LocalFormOutcome.Ended => CoreStrings.LocalForm_Of_6,
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
        "device_refused" => CoreStrings.LocalForm_Failure_1,
        "connection_closed" => CoreStrings.LocalForm_Failure_2,
        "ended" => PeriodEnded,
        "purchase_failed" or "purchase_unverified" => CoreStrings.LocalForm_Failure_3,   // the Apple app's sentence (LocalAccount.words), no code
        "not_paid" or "revoked" or "proof_invalid" or "not_this_app" or "product_unknown" or "sandbox_refused" => CoreStrings.LocalForm_Failure_4(code),
        "bad_request" or "provider_unsupported" => CoreStrings.LocalForm_Failure_5,
        "network" or "unreachable" => CoreStrings.LocalForm_Failure_6,
        "signin_required" => CoreStrings.LocalForm_Failure_7,
        "return_not_received" => CoreStrings.LocalForm_Failure_8,
        "signin_failed" => detail is { Length: > 0 } why ? CoreStrings.LocalForm_Failure_9(why) : CoreStrings.LocalForm_Failure_10,
        _ => CoreStrings.LocalForm_Failure_11(code),
    };
}
