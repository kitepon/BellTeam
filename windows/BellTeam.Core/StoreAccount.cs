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
}

// Provisional words (the contract fixes behaviour, not copy): Tronie decides the final wording. No e-mail or name exists anywhere, so none is shown.
public static class StoreAccountText
{
    public const string Title = "アカウントと購読";
    public const string SignedOut = "サインインしていません。";
    public const string SignIn = "Googleでサインイン";
    public const string SignedIn = "Googleでサインイン中";
    public const string HandoffCannotBuy = "この端末では購入できません。";
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
    public const string AlreadyEntitled = "すでに使えます。";
    public const string NotConfigured = "購読の接続先がまだ決まっていません。";
    public static string Buy(string price) => $"購入（{price}）";
    public static string Failure(string code, int? reason = null) => code switch
    {
        "product_unknown" => "この商品はまだ読み込めていません。もう一度お試しください。",
        "pass_invalid" => "サインインし直してください。",
        _ => "うまくいきませんでした（" + code + (reason is { } number ? " " + number : "") + "）。",
    };
}
