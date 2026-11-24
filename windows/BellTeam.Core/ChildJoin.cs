namespace BellTeam.Core;

/// <summary>
/// The words of the 決裁箱 window's child join (child-join.md, Delta 2026-11-24: the table's strings, BellTeam's own; the library owns no guidance text). One block for every client.
/// The sign-in lines before the QR are the first screen's (<see cref="LocalFormText.FirstSignIn"/>) and the QR text beside it is <see cref="LocalFormText.Qr"/>, word for word; the validity line is <see cref="LocalFormText.ValidUntil"/>.
/// </summary>
public static class ChildJoinText
{
    public const string Title = "決裁箱につなぎます", Lead = "この端末を、あなたの決裁箱に子の端末として追加します。";
    public const string WaitingTitle = "決裁箱の承認を待っています", QrLabel = "決裁箱につなぐQRコード";
    public const string Failed = "つなげませんでした。もう一度つないでください。";
    // other_account: this device and the parent are signed in to different accounts (no server, no ID).
    public const string OtherAccount = "この端末と親の端末で、サインインしているアカウントが違います。親の端末と同じアカウント（AppleかGoogle）でこの端末にサインインして、もう一度QRコードを出してください。";
    public const string Removed = "決裁箱で、この端末のつなぎが外されました。";
    public const string Joining = "つないでいます…", Reconnecting = "つなぎ直しています", Joined = "決裁箱につながっています";
    public const string NotEntitled = "Approval Boxの契約が必要です。契約はApproval Boxのアプリで行います。";
    public const string UpdateRequired = "この版では、決裁箱をまだ使えません。アプリを更新してください。";
    public const string Connect = "決裁箱につなぐ", ConnectAgain = "もう一度つなぐ", Leave = "つなぎを外す", LeaveYes = "外す", LeaveNo = "やめる", Retry = "今すぐ試す", Recheck = "確かめ直す";

    /// <summary>The line under a failed join: the library's own code never reaches the person; only other_account has its own sentence.</summary>
    public static string FailedLine(string? code) => code == "other_account" ? OtherAccount : Failed;
}
