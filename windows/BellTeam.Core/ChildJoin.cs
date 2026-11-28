namespace BellTeam.Core;

/// <summary>
/// The words of the 決裁箱 window's child join (child-join.md, Delta 2026-11-24: the table's strings, BellTeam's own; the library owns no guidance text). One block for every client.
/// The sign-in lines before the QR are the first screen's (<see cref="LocalFormText.FirstSignIn"/>) and the QR text beside it is <see cref="LocalFormText.Qr"/> (the sentence stays; BellTeam's display is BellTeam's); the validity line is <see cref="LocalFormText.ValidUntil"/>.
/// </summary>
public static class ChildJoinText
{
    public const string Title = "決裁箱につなぎます", Lead = "この端末を、あなたの決裁箱に子の端末として追加します。";
    public const string WaitingTitle = "決裁箱の承認を待っています", QrLabel = "決裁箱につなぐQRコード";
    // The code beside the QR (login-billing 1.60): Approval Box's own paste field takes it, which is how a phone that is also the parent joins.
    // CodeHint: a PC (the QR is read by the phone that has 決裁箱). CodeHintPhone: a phone, where the parent is usually this same phone, so the first action opens the code in 決裁箱; the other cases follow in the same words.
    public const string CodeOpen = "決裁箱で開く";
    public const string CodeHint = "決裁箱のあるスマートフォンでQRコードを読むか、このコードをコピーして、決裁箱の「ほかの端末を追加する」に貼り付けてください。";
    public const string CodeHintPhone = "このスマートフォンに決裁箱がある時は、「決裁箱で開く」を押してください。ほかの端末で承認する時は、その端末でQRコードを読むか、このコードをコピーして決裁箱の「ほかの端末を追加する」に貼り付けてください。";
    public const string Failed = "つなげませんでした。もう一度つないでください。";
    // The join code beside the QR (login-billing 0.25, the Owner's K-A9DW3Q): for a QR that cannot be read, e.g. on the same phone. Wording is BellTeam's own until Rapi's table says otherwise.
    public const string CodeLabel = "参加コード", CopyCode = "コードをコピー";
    public const string CodeLead = "QRを読めない時は、このコードをコピーして、決裁箱のアプリに貼り付けてください。";
    // other_account: this device and the parent are signed in to different accounts (no server, no ID).
    public const string OtherAccount = "この端末と親の端末で、サインインしているアカウントが違います。親の端末と同じアカウント（AppleかGoogle）でこの端末にサインインして、もう一度QRコードを出してください。";
    public const string Removed = "決裁箱で、この端末のつなぎが外されました。";
    public const string Joining = "つないでいます…", Reconnecting = "つなぎ直しています", Joined = "決裁箱につながっています";
    public const string NotEntitled = "Approval Boxの契約が必要です。契約はApproval Boxのアプリで行います。";
    public const string UpdateRequired = "この版では、決裁箱をまだ使えません。アプリを更新してください。";
    public const string Connect = "決裁箱につなぐ", ConnectAgain = "もう一度つなぐ", Leave = "つなぎを外す", LeaveYes = "外す", LeaveNo = "やめる", Retry = "今すぐ試す", Recheck = "確かめ直す";

    /// <summary>The line under a failed join: the library's own code never reaches the person; only other_account has its own sentence.</summary>
    /// <summary>words: the library's own text for a local-network cause, shown word for word (login-billing 1.61).</summary>
    public static string FailedLine(string? code, string? words = null) => code == "other_account" ? OtherAccount : words is { Length: > 0 } ? words : Failed;
}
