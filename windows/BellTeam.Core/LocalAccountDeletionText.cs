namespace BellTeam.Core;

// a540 「アカウントを削除」: Rapi's final table (Poli approved, 2026-11-23; docs/architecture/modules/apple/account-deletion.md). Nothing about a person is held on any BellTeam server, so the deletion is a local sign-out plus the Approval Box sign-out.
// Only the sentence about the subscription belongs to each platform's store: the caller passes its own (Windows: Subscription / Cancel below). Everything else is fixed.
public static class LocalAccountDeletionText
{
    public const string Button = "アカウントを削除";
    public const string ConfirmTitle = "アカウントを削除しますか？";
    public const string ConfirmYes = "削除する";
    public const string ConfirmNo = "やめる";
    public const string ResultTitle = "アカウントを削除しました";

    public static string ConfirmBody(string subscription) =>
        "この端末のBellTeamのサインインと、受け取った購読の確認を消します。決裁箱のサインインと鍵、サーバーのトークン、保存した会話の写しも消して、最初の画面に戻ります。"
        + "BellTeamは、名前・メールアドレス・購入の記録を、サーバーにも運営にも持っていません。決裁箱は、サインインを終えるだけです。決裁箱のアカウントと申請は消えません。消すには、決裁箱のアプリでアカウントを削除してください。"
        + "決裁箱の運営には、止めたサインインのランダムな番号も最長14日残ります。ほかの端末のサインインは、その端末で終えてください。"
        + subscription + "サーバーの会話や設定は消えません。";

    // The result is told only when both sign-outs returned.
    public static string ResultBody(string cancel) =>
        "この端末のサインインとデータを消しました。BellTeamの運営は、あなたに関する情報を持っていません。あなたのサーバーの会話と設定は残ります。決裁箱のアカウントは、決裁箱のアプリで削除するまで残ります。" + cancel;

    // A Windows PC never buys: its subscription is the one a phone bought in its own store (Apple or Google Play).
    public const string Subscription = "購読は購入したスマホのストアのものなので、この操作では解約されません。解約は、そのスマホで、購読の管理から行ってください。";
    public const string Cancel = "購読を止めるには、購入したスマホの購読の管理から解約してください。";

    // Told when a step could not finish: it names the part and one of three reasons; pressing again continues (the steps done stay done).
    public const string FailedTitle = "アカウントの削除を終えられませんでした";
    public const string NoNetwork = "ネットワークにつながっていません";
    public const string OperatorUnreachable = "決裁箱の運営に届きません";
    public const string NotProcessed = "処理できませんでした";
    public static string Failed(string part, string reason) =>
        part + "を消せませんでした（" + reason + "）。つながる場所でもう一度「" + Button + "」を押すと、続きから終えます。すでに終えた手順はそのままです。";
}
