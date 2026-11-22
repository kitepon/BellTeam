namespace BellTeam.Core;

// The store account of an app that signs in with Google or Apple itself (login-billing contract 1.20, a485). Plain strings so Core needs no library type:
// passKind is the library's "none" | "store" | "handoff"; entitlementCount is how many entitlements the pass holds.
public enum StoreAccountState { SignedOut, SignedInNeedsPurchase, SignedInEntitled, Handoff, Signed }

public static class StoreAccount
{
    public static StoreAccountState Of(string passKind, int entitlementCount) => passKind switch
    {
        "store" => entitlementCount > 0 ? StoreAccountState.SignedInEntitled : StoreAccountState.SignedInNeedsPurchase,
        "handoff" => StoreAccountState.Handoff,
        "signed" => StoreAccountState.Signed, // web sign-in (contract 1.20): never buys here
        _ => StoreAccountState.SignedOut,
    };

    // The Mac 利用と課金 page head (SettingsSummary.billing): one badge and one sentence.
    public static (string Badge, SettingsTone Tone, string Line) Status(bool entitled)
        => entitled ? ("有効", SettingsTone.Green, "購読中です") : ("未設定", SettingsTone.Gray, "購読していません");
}

// Provisional words (the contract fixes behaviour, not copy): Tronie decides the final wording. No e-mail or name exists anywhere, so none is shown.
public static class StoreAccountText
{
    public const string Title = "アカウントと購読";
    public const string SignedOut = "サインインしていません。";
    public const string SignIn = "Googleでサインイン";
    public const string SignedIn = "Googleでサインイン中";
    // Desktop (Linux, Windows): the library signs in through the system browser and returns to a loopback address; no purchase happens here (login-billing 0.14.0). Provisional words, like the rest.
    public const string SignInApple = "Appleでサインイン";
    public const string SigningInWeb = "ブラウザーでのサインインを待っています…";
    public const string SigningInWebCancel = "やめる";
    public const string StopAllOthersWhyWeb = "このアカウントでログインしている、ほかのすべての端末を止めます。この端末は使い続けられます。ブラウザーでもう一度サインインします。サインインに使ったほうを選んでください。";
    public const string StopAllOthersGoogle = "Googleで止める";
    public const string StopAllOthersApple = "Appleで止める";
    public const string SignedInBrowser = "ブラウザーでサインイン中";
    public const string WebCannotBuy = "ブラウザーでサインインした端末では、ここで購入できません。購読しているスマホから引き継いでください。";
    public const string HandoffCancel = "やめる";
    public const string HandoffCancelled = "引き継ぎをやめました。";
    public const string StopAllOthersWhy = "このアカウントでログインしている、ほかのすべての端末を止めます。この端末は使い続けられます。Googleでもう一度サインインします。";
    public const string StopAllOthersConfirm = "止める";
    public const string StopAllOthersCancel = "キャンセル";   // not やめる: 止める and やめる sound the same side by side (Mika, 7f)
    public const string HandoffAgain = "スマホで引き継ぐ";
    public const string OtherAccount = "別のアカウントで購入したものがあります。このアカウントでは購読になりません。";
    public const string Refresh = "再確認";
    public const string StopAllOthers = "ほかの端末をすべて止める";
    public const string SignOut = "サインアウト";
    // app-sessions.md 7f (Mika), the handoff QR for a device with no store receipt: Anis's sentences as written.
    public const string HandoffTitle = "スマホで購読を引き継ぐ";
    public const string HandoffLead = "購読しているスマホのBellTeamで、このQRを読み取ってください。読み取れない時は、下のコードを入れてください。";
    public const string HandoffCode = "コード";
    public const string HandoffCheckNumber = "確認番号";
    public const string HandoffCheckLine = "スマホに出る確認番号が同じか、見比べてください。";
    public const string HandoffWaiting = "スマホの承認を待っています…";
    // The phone that holds the contract (a store pass) lets another device in, and lists and stops the devices it let in (contract 1.20; a desktop is only ever the device that gets approved). Provisional words.
    public const string ApproveTitle = "ほかの端末のログインを許可する";
    public const string ApproveLead = "ログインしたい端末に出ているQRを読み取るか、コードを入れてください。";
    public const string ApproveScan = "QRを読み取る";
    public const string ApproveCodeLabel = "コード";
    public const string ApproveCodeGo = "続ける";
    public const string ApproveCheckLine = "ログインしたい端末に出ている確認番号と同じか、見比べてください。";
    public const string ApproveOwnLine = "自分で始めたログインだけ許可してください。";
    public const string ApproveYes = "許可";
    public const string ApproveNo = "許可しない";
    public const string ApprovedLine = "許可しました。";
    public const string DeclinedLine = "許可しませんでした。";
    public const string NotNeededLine = "その端末はすでに使えます。";
    public const string ApproveScanFailed = "QRを読み取れませんでした。コードを入れてください。";
    public const string ApproveConfirmAsk = "このログインを許可しますか？";
    public static string ApproveDevice(string label) => "端末：" + label;
    public const string LinkedTitle = "許可した端末";
    public const string LinkedNone = "許可した端末はありません。";
    public const string LinkedStop = "止める";
    public const string AlreadyEntitled = "すでに使えます。";
    public const string GateNext = "サーバーにつなぐ";   // provisional (Tronie/Mika): the step after the account on first run
    public const string NotConfigured = "購読の接続先がまだ決まっていません。";
    public static string Buy(string price) => $"購入（{price}）";
    // The period comes from the offer's ISO 8601 billing period (P1M, P1Y, P1W, P3M...), never hard-coded; an unknown period shows the price alone.
    public static string Buy(string price, string? billingPeriod) => Period(billingPeriod) is { } period ? $"購入（{period}{price}）" : Buy(price);
    private static string? Period(string? iso) => iso switch { "P1W" => "週額", "P1M" => "月額", "P3M" => "3か月ごと", "P6M" => "6か月ごと", "P1Y" => "年額", _ => null };
    public static string Failure(string code, int? reason = null) => code switch
    {
        "product_unknown" => "この商品はまだ読み込めていません。もう一度お試しください。",
        "pass_invalid" => "サインインし直してください。",
        "signin_cancelled" => "サインインをやめました。",
        "return_not_received" => "サインインの結果が戻ってきませんでした。もう一度お試しください。",
        "pass_store_unavailable" => "この端末のサインイン情報を読めません。いったんサインアウトしてから、もう一度サインインしてください。",
        _ => "うまくいきませんでした（" + code + (reason is { } number ? " " + number : "") + "）。",
    };
}
