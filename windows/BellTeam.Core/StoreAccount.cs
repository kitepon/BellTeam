namespace BellTeam.Core;

// The store account of an app that signs in with Google or Apple itself (login-billing contract 1.20, a485). Plain strings so Core needs no library type:
// passKind is the library's "none" | "store" | "handoff"; entitlementCount is how many entitlements the pass holds.
public enum StoreAccountState { SignedOut, SignedInNeedsPurchase, SignedInEntitled, Handoff }

public static class StoreAccount
{
    public static StoreAccountState Of(string passKind, int entitlementCount) => passKind switch
    {
        "store" => entitlementCount > 0 ? StoreAccountState.SignedInEntitled : StoreAccountState.SignedInNeedsPurchase,
        "handoff" => StoreAccountState.Handoff,
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
    public const string NotConfigured = "購読の接続先がまだ決まっていません。";
    public static string Buy(string price) => $"購入（{price}）";
    public static string Failure(string code) => code switch
    {
        "product_unknown" => "この商品はまだ読み込めていません。もう一度お試しください。",
        "pass_invalid" => "サインインし直してください。",
        _ => "うまくいきませんでした（" + code + "）。",
    };
}
