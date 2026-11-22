namespace BellTeam.Linux;

// 「アカウントを削除」 (a485 switch; App Review and Google Play require it). Placement and words are Rapi's Mac reference (docs/architecture/modules/apple/account-deletion.md):
// the last item of the account card, under a divider, shown whenever the Worker is configured, signed in or not. Only the subscription sentences name the platform's store.
public static class AccountDeletionWords
{
    public const string Button = "アカウントを削除", Title = "アカウントを削除しますか？", Confirm = "削除する", Cancel = "やめる", DoneTitle = "アカウントを削除しました";

    // store: whose subscription it is ("Google Play"); manage: where it is cancelled ("Google Playの「定期購入」").
    public static string Message(string store, string manage) =>
        "この端末のBellTeamのサインインを、届く限りすべて終わらせます。この端末にある店のパス・アカウントの番号・サーバーのトークン・決裁箱のサインインと鍵・保存した会話の写しを消して、最初の画面に戻ります。"
        + "ログインの運営は、このアカウントに結びつけた情報を持っていません。ほかの端末のサインインは、その端末で終えてください。"
        + $"購読は{store}のものなので、この操作では解約されません。解約は{manage}から行ってください。サーバーの会話や設定は消えません。";

    public static string Done(string manage) =>
        $"この端末のサインインとデータを消しました。ログインの運営には、このアカウントの情報は残っていません。購読を止めるには、{manage}から解約してください。";
}

// The app shell sets Run (it owns the connection, the tokens and the first screen); the account card calls it after the person confirms. A failure is thrown to the card, which shows it.
public static class AccountDeletion
{
    public static Func<Task>? Run { get; set; }
}
