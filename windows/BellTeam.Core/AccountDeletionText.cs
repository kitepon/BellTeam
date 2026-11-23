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

    // a540 (Rapi's final table, Poli approved 2026-11-23): BellTeam holds nothing on any server; what stays is the user's own server's conversations and the Approval Box account. Only the store sentence is each OS's own.
    public static string ConfirmBody(string subscription) =>
        "この端末のBellTeamのサインインと、受け取った購読の確認を消します。決裁箱のサインインと鍵、サーバーのトークン、保存した会話の写しも消して、最初の画面に戻ります。"
        + "BellTeamは、名前・メールアドレス・購入の記録を、サーバーにも運営にも持っていません。決裁箱は、サインインを終えるだけです。決裁箱のアカウントと申請は消えません。消すには、決裁箱のアプリでアカウントを削除してください。"
        + "決裁箱の運営には、止めたサインインのランダムな番号も最長14日残ります。ほかの端末のサインインは、その端末で終えてください。"
        + subscription + "サーバーの会話や設定は消えません。";

    public static string ResultBody(string cancel) =>
        "この端末のサインインとデータを消しました。BellTeamの運営は、あなたに関する情報を持っていません。あなたのサーバーの会話と設定は残ります。決裁箱のアカウントは、決裁箱のアプリで削除するまで残ります。" + cancel;

    // A Windows PC never buys: its subscription is the one the phone (or the web) bought, so the store words name no single store.
    public const string Subscription = "購読は購入した先（AppleやGoogle Playなど）のものなので、この操作では解約されません。解約は、購入した先の購読の管理から行ってください。";
    public const string Cancel = "購読を止めるには、購入した先の購読の管理から解約してください。";

    // The result is told only when every step returned; otherwise this names the part that could not be removed and one of three reasons, and pressing again continues (the steps done stay done).
    public const string FailedTitle = "アカウントの削除を終えられませんでした";
    public const string NoNetwork = "ネットワークにつながっていません";
    public const string OperatorUnreachable = "決裁箱の運営に届きません";
    public const string NotProcessed = "処理できませんでした";
    public static string Failed(string part, string reason) =>
        part + "を消せませんでした（" + reason + "）。つながる場所でもう一度「" + Button + "」を押すと、続きから終えます。すでに終えた手順はそのままです。";
}
