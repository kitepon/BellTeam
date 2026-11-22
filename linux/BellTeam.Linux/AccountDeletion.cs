namespace BellTeam.Linux;

// 「アカウントを削除」 (a485 switch): the words are Core's AccountDeletionText (Rapi's Mac reference); each platform passes only its own two subscription sentences.
// The app shell sets Run (it owns the connection, the tokens and the first screen); the account card calls it after the person confirms. A failure is thrown to the card, which shows it.
public static class AccountDeletion
{
    public static Func<Task>? Run { get; set; }
}

// The sign-outs that reach a server (Approval Box, the home server, the login service) are not swallowed: the library keeps everything when the server was not reached, so pressing the button again finishes them.
// 「削除しました」 is shown only when this list is empty; otherwise the result says what could not be removed and why (Tronie 2026-11-23, Mint's read of the Apple copy).
public sealed class DeletionFailures
{
    private readonly List<string> lines = [];
    public bool Any => lines.Count != 0;
    public void Add(string what, string reason) => lines.Add($"・{what}：{reason}");
    public string Text => "次のサインインは終えられませんでした。\n" + string.Join('\n', lines) + "\nもう一度「アカウントを削除」を押すと、残りを終えます。";
}
