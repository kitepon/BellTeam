namespace BellTeam.Linux;

// 「アカウントを削除」 (a485 switch): the words are Core's AccountDeletionText (Rapi's Mac reference); each platform passes only its own two subscription sentences.
// The app shell sets Run (it owns the connection, the tokens and the first screen); the account card calls it after the person confirms. A failure is thrown to the card, which shows it.
public static class AccountDeletion
{
    public static Func<Task>? Run { get; set; }
}
