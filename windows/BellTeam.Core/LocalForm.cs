namespace BellTeam.Core;

// a540 (login-billing contract 1.36 s10, "The local form"): what one request of the wanting device can end in. The library's own result type maps onto this (Purika's names come with t10b); only these words reach the person.
public enum LocalFormOutcome { Paid, NoPurchase, AnotherAccount, SameWifi, PrivateNetwork, Refused, Ended }

public static class LocalForm
{
    // The listener of one request closes after this long (contract s10); the person then asks for a new QR.
    public const int ListenMinutes = 10;
    // A device's own clock decides when a period ends (contract s10, limits); without an accepted period there is nothing to renew from, so the next step is a QR too.
    public static bool NeedsNewRequest(DateTimeOffset? paidUntil, DateTimeOffset now) => paidUntil is not { } until || until <= now;
}

// Provisional words (the contract fixes the meaning, not the Japanese): Tronie/Bready decide the final wording. The strings the contract quotes are in the comments.
public static class LocalFormText
{
    public const string Title = "スマホで確認する";
    // makeRequest: the QR is read by the paying phone, over the same local network.
    public const string Lead = "購読しているスマホのBellTeamで、このQRを読み取ってください。スマホとこのパソコンは、同じWi-Fiにつないでください。";
    public const string Waiting = "スマホの返事を待っています…";
    public const string Window = "このQRは、このパソコンが待っている間だけ使えます（10分）。";
    public const string Cancel = "やめる";
    public const string NewQr = "新しいQRを出す";
    // The firewall's first prompt is the person's one step (contract s10, Windows).
    public const string Firewall = "Windowsのファイアウォールの確認が出たら、許可してください。";
    public const string PeriodEnded = "購読の期間が終わりました。新しいQRで、もう一度スマホに確認してもらってください。";
    public static string Paid(DateTimeOffset until) => "購読を確認しました。" + SubscriptionText.ValidUntil(until);

    // "put both on the same Wi-Fi" / "..., marked as a private network" / "another account" / "no purchase" / a refused reply / the 10-minute end. Paid is spoken by Paid(until).
    public static string Of(LocalFormOutcome outcome) => outcome switch
    {
        LocalFormOutcome.SameWifi => "スマホとこのパソコンを、同じWi-Fiにつないでください。",
        LocalFormOutcome.PrivateNetwork => "スマホとこのパソコンを、同じWi-Fiにつないでください。このパソコンのWi-Fiは「プライベート ネットワーク」にしてください。",
        LocalFormOutcome.NoPurchase => "このスマホには購読がありません。購読しているスマホで読み取ってください。",
        LocalFormOutcome.AnotherAccount => "スマホは別のアカウントでサインインしています。このパソコンと同じアカウントのスマホで読み取ってください。",
        LocalFormOutcome.Refused => "スマホの返事を受け取れませんでした。新しいQRで、もう一度お試しください。",
        LocalFormOutcome.Ended => "QRの待ち時間（10分）が過ぎました。新しいQRを出してください。",
        _ => throw new ArgumentOutOfRangeException(nameof(outcome), outcome, "Paid is shown with its end time: LocalFormText.Paid"),
    };
}
