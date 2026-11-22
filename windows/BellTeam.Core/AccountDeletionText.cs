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

    public static string ConfirmBody(string subscription) =>
        "この端末のBellTeamのサインインを、届く限りすべて終わらせます。この端末にある店のパス・アカウントの番号・サーバーのトークン・決裁箱のサインインと鍵・保存した会話の写しを消して、最初の画面に戻ります。"
        + "ログインの運営は、このアカウントに結びつけた情報を持っていません。ほかの端末のサインインは、その端末で終えてください。"
        + subscription + "サーバーの会話や設定は消えません。";

    public static string ResultBody(string cancel) =>
        "この端末のサインインとデータを消しました。ログインの運営には、このアカウントの情報は残っていません。" + cancel;

    // A Windows PC never buys: its subscription is the one the phone (or the web) bought, so the store words name no single store.
    public const string Subscription = "購読は購入した先（AppleやGoogle Playなど）のものなので、この操作では解約されません。解約は、購入した先の購読の管理から行ってください。";
    public const string Cancel = "購読を止めるには、購入した先の購読の管理から解約してください。";

    // a485 follow-up (Tronie, from Mint): the result is told only when every step returned; otherwise this names what could not be removed and why, and pressing again finishes it.
    public const string FailedTitle = "アカウントの削除を終えられませんでした";
    public static string Failed(string what, string why) =>
        what + "を消せませんでした。理由：" + why.TrimEnd('。', ' ') + "。ここまでに消したものは、消えたままです。もう一度「" + Button + "」を押すと、続きを行います。";
}
