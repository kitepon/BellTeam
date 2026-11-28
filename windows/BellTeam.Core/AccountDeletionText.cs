namespace BellTeam.Core;

// a485 「アカウントを削除」 (App Review): placement and wording are Rapi's Mac reference (docs/architecture/modules/apple/account-deletion.md).
// Only the sentences about the subscription belong to each platform's store: the caller passes its own (Windows: Subscription / Cancel below).
public static class AccountDeletionText
{
    public static string Button  => CoreStrings.AccountDeletionText_Button_1;
    public static string ConfirmTitle  => CoreStrings.AccountDeletionText_ConfirmTitle_1;
    public static string ConfirmYes  => CoreStrings.AccountDeletionText_ConfirmYes_1;
    public static string ConfirmNo  => CoreStrings.AccountDeletionText_ConfirmNo_1;
    public static string ResultTitle  => CoreStrings.AccountDeletionText_ResultTitle_1;

    // a540 (Rapi's final table, Poli approved 2026-11-23): BellTeam holds nothing on any server; what stays is the user's own server's conversations and the Approval Box account. Only the store sentence is each OS's own.
    public static string ConfirmBody(string subscription) =>
        CoreStrings.AccountDeletionText_ConfirmBody_1(subscription);

    public static string ResultBody(string cancel) =>
        CoreStrings.AccountDeletionText_ResultBody_1(cancel);

    // A Windows PC never buys: its subscription is the one the phone (or the web) bought, so the store words name no single store.
    public static string Subscription  => CoreStrings.AccountDeletionText_Subscription_1;
    public static string Cancel  => CoreStrings.AccountDeletionText_Cancel_1;

    // The result is told only when every step returned; otherwise this names the part that could not be removed and one of three reasons, and pressing again continues (the steps done stay done).
    public static string FailedTitle  => CoreStrings.AccountDeletionText_FailedTitle_1;
    public static string NoNetwork  => CoreStrings.AccountDeletionText_NoNetwork_1;
    public static string OperatorUnreachable  => CoreStrings.AccountDeletionText_OperatorUnreachable_1;
    public static string NotProcessed  => CoreStrings.AccountDeletionText_NotProcessed_1;
    public static string Failed(string part, string reason) =>
        CoreStrings.AccountDeletionText_Failed_1(part, reason, Button);
}
