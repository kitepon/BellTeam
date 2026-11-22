using BellTeam.Core;

namespace BellTeam.Linux;

// 「アカウントを削除」 (a485 switch): the words are Core's AccountDeletionText (Rapi's Mac reference); each platform passes only its own two subscription sentences.
// The app shell sets Run (it owns the connection, the tokens and the first screen); the account card calls it after the person confirms. A failure is thrown to the card, which shows it.
public static class AccountDeletion
{
    public static Func<Task>? Run { get; set; }
}

// The steps that reach a server (push registration, Approval Box, home server, login service) are not swallowed: the home-server end keeps its record when the server was not reached, so pressing again finishes it. The library's own sign-out (0.18.9, contract 1.31) removes the pass offline too and only throws pass_store_unavailable; its Delivered/NotDelivered result needs no extra words (the result text already says what the operator keeps for up to 14 days).
// 「削除しました」 is shown only when this list is empty; otherwise the result says which part could not be removed and why, in Rapi's words (Core's AccountDeletionText.Failed; Tronie 2026-11-23, R1/R2).
public sealed class DeletionFailures
{
    private readonly List<string> lines = [];
    public bool Any => lines.Count != 0;
    // status: the HTTP status the library or the home link reported (0 when there is none).
    public void Add(string part, Exception error, int status = 0) => lines.Add(AccountDeletionText.Failed(part, ReasonOf(error, status)));
    public string Text => string.Join('\n', lines);

    // The three reasons the reference allows: a network failure anywhere in the chain (a cancelled call is the push request's own 3-second limit), the login operator answering 5xx, anything else.
    internal static string ReasonOf(Exception error, int status)
    {
        for (var e = error; e is not null; e = e.InnerException)
            if (e is System.Net.Http.HttpRequestException or System.Net.Sockets.SocketException or TimeoutException or OperationCanceledException) return AccountDeletionText.NoNetwork;
        return status >= 500 ? AccountDeletionText.OperatorUnreachable : AccountDeletionText.NotProcessed;
    }
}
