namespace BellTeam.Core;

/// <summary>
/// The words of the 決裁箱 window's child join (child-join.md, Delta 2026-11-24: the table's strings, BellTeam's own; the library owns no guidance text). One block for every client.
/// The sign-in lines before the QR are the first screen's (<see cref="LocalFormText.FirstSignIn"/>) and the QR text beside it is <see cref="LocalFormText.Qr"/> (the sentence stays; BellTeam's display is BellTeam's); the validity line is <see cref="LocalFormText.ValidUntil"/>.
/// </summary>
public static class ChildJoinText
{
    public static string Title  => CoreStrings.ChildJoin_Title_1;
    public static string Lead  => CoreStrings.ChildJoin_Lead_1;
    public static string WaitingTitle  => CoreStrings.ChildJoin_WaitingTitle_1;
    public static string QrLabel  => CoreStrings.ChildJoin_QrLabel_1;
    // The code beside the QR (login-billing 1.60): Approval Box's own paste field takes it, which is how a phone that is also the parent joins.
    // CodeHint: a PC (the QR is read by the phone that has 決裁箱). CodeHintPhone: a phone, where the parent is usually this same phone, so the first action opens the code in 決裁箱; the other cases follow in the same words.
    public static string CodeOpen  => CoreStrings.ChildJoin_CodeOpen_1;
    public static string CodeHint  => CoreStrings.ChildJoin_CodeHint_1;
    public static string CodeHintPhone  => CoreStrings.ChildJoin_CodeHintPhone_1;
    public static string Failed  => CoreStrings.ChildJoin_Failed_1;
    // The join code beside the QR (login-billing 0.25, the Owner's K-A9DW3Q): for a QR that cannot be read, e.g. on the same phone. Wording is BellTeam's own until Rapi's table says otherwise.
    public static string CodeLabel  => CoreStrings.ChildJoin_CodeLabel_1;
        public static string CopyCode  => CoreStrings.ChildJoin_CopyCode_1;
    public static string CodeLead  => CoreStrings.ChildJoin_CodeLead_1;
    // other_account: this device and the parent are signed in to different accounts (no server, no ID).
    public static string OtherAccount  => CoreStrings.ChildJoin_OtherAccount_1;
    public static string Removed  => CoreStrings.ChildJoin_Removed_1;
    public static string Joining  => CoreStrings.ChildJoin_Joining_1;
    public static string Reconnecting  => CoreStrings.Approvals_DeviceReconnecting_1;
    public static string Joined  => CoreStrings.ChildJoin_Joined_1;
    public static string NotEntitled  => CoreStrings.Approvals_DeviceNotEntitled_1;
    public static string UpdateRequired  => CoreStrings.Approvals_DeviceUpdateNeeded_1;
    public static string Connect  => CoreStrings.ChildJoin_Connect_1;
    public static string ConnectAgain  => CoreStrings.ChildJoin_ConnectAgain_1;
    public static string Leave  => CoreStrings.ChildJoin_Leave_1;
    public static string LeaveYes  => CoreStrings.ChildJoin_LeaveYes_1;
    public static string LeaveNo  => CoreStrings.AccountDeletionText_ConfirmNo_1;
    public static string Retry  => CoreStrings.ChildJoin_Retry_1;
    public static string Recheck  => CoreStrings.ChildJoin_Recheck_1;

    /// <summary>The line under a failed join: the library's own code never reaches the person; only other_account has its own sentence.</summary>
    /// <summary>words: the library's own text for a local-network cause, shown word for word (login-billing 1.61).</summary>
    public static string FailedLine(string? code, string? words = null) => code == "other_account" ? OtherAccount : words is { Length: > 0 } ? words : Failed;
}
