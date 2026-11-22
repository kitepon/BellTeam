namespace BellTeam.Core;

// a485 「アカウントを削除」 (App Review): placement and wording are Rapi's Mac reference (docs/architecture/modules/apple/account-deletion.md).
// Only the sentences about the subscription belong to each platform's store: the caller passes its own (Windows: Subscription / Cancel below).
public static class AccountDeletionText
{
    public const string Button = "アカウントを削除";
    public const string ConfirmTitle = "アカウントを削除しますか？";
    public const string ConfirmYes = "削除する";
    public const string ConfirmNo = "やめる";
    public const string ResultTitle = "アカウントを削除しました";

    // 2026-11-23 R2 (Mint's read; Rapi + Poli final): says only what is true, name / e-mail / purchases are not held and what stays is gone within 14 days.
    public static string ConfirmBody(string subscription) =>
        "この端末のBellTeamのサインインを、届く限りすべて終わらせます。この端末にある店のパス・アカウントの番号・サーバーのトークン・決裁箱のサインインと鍵・保存した会話の写しを消して、最初の画面に戻ります。"
        + "ログインの運営は、名前・メールアドレス・購入の記録を持っていません。" + Remains
        + "ほかの端末のサインインは、その端末で終えてください。"
        + subscription + "サーバーの会話や設定は消えません。";

    public static string ResultBody(string cancel) =>
        "この端末のサインインとデータを消しました。" + Remains + cancel;

    private const string Remains = "ログインの運営に残るのは、止めたパスのランダムな番号と、「ほかの端末をすべて止める」を使った時のアカウントの番号とその時刻だけで、どちらも最長14日で消えます。";

    // A Windows PC never buys: its subscription is the one the phone (or the web) bought, so the store words name no single store.
    public const string Subscription = "購読は購入した先（AppleやGoogle Playなど）のものなので、この操作では解約されません。解約は、購入した先の購読の管理から行ってください。";
    public const string Cancel = "購読を止めるには、購入した先の購読の管理から解約してください。";

    // The result is told only when every step returned; otherwise this names the part that could not be removed and one of three reasons, and pressing again continues (the steps done stay done).
    public const string FailedTitle = "アカウントの削除を終えられませんでした";
    public const string NoNetwork = "ネットワークにつながっていません";
    public const string OperatorUnreachable = "ログインの運営に届きません";
    public const string NotProcessed = "処理できませんでした";
    public static string Failed(string part, string reason) =>
        part + "を消せませんでした（" + reason + "）。つながる場所でもう一度「" + Button + "」を押すと、続きから終えます。すでに終えた手順はそのままです。";
}
