using System.Net;

namespace BellTeam.Core;

// 「AIの許可待ちを決裁箱へ送る」: the body pairs once as a connector of the Owner's Approval Box account, by the Owner's QR scan (docs/architecture/modules/approval-box-extension/seat-approval-card.md, "The pairing view").
// Drawn only from the body routes GET /api/approvals/seat-link, POST …/start, POST …/stop; the same view and words on every client. Never a token, never a path to Approval Box.
public sealed record SeatLink
{
    /// <summary>none | waiting | linked | removed | failed | unavailable (the last one is the client's: the route could not be read).</summary>
    public string State { get; init; } = "unavailable";
    public string? Code { get; init; }
    /// <summary>The typed code shown beside the QR (the pairing's typed secret).</summary>
    public string? TypedSecret { get; init; }
    /// <summary>The text the QR draws.</summary>
    public string? QrText { get; init; }
    public DateTimeOffset? ExpiresAt { get; init; }
    /// <summary>failed: rejected | expired | other.</summary>
    public string? Reason { get; init; }
    public bool Waiting => State == "waiting" && QrText is { Length: > 0 };
}

public static class SeatLinkText
{
    public const string Title = "AIの許可待ちを決裁箱へ送る", Connect = "つなぐ", Again = "もう一度つなぐ", Cancel = "やめる";
    public const string None = "AIが許可を待って止まった時、決裁箱のアプリに届きます。つなぐのは1回だけです。",
        Steps = "決裁箱のアプリで、接続 → 「AIをつなぐ」 → 「QRコードを読む」を開き、このQRコードを読んで、許可してください。",
        Linked = "つながっています。AIが許可待ちで止まると、決裁箱に届きます。",
        Removed = "決裁箱でつなぎが外されています。もう一度つないでください。",
        Rejected = "決裁箱のアプリで「心当たりがない」が押されました。",
        Expired = "許可の待ち時間が過ぎました。もう一度つないでください。",
        Unavailable = "いまはつなげません。少し待って、もう一度押してください。";

    /// <summary>The plain line of a state (the contract's table). Only failed and unavailable are for a red line (<see cref="IsFailure"/>).</summary>
    public static string Line(SeatLink link) => link.State switch
    {
        "none" => None, "waiting" => Steps, "linked" => Linked, "removed" => Removed,
        "failed" => link.Reason switch { "rejected" => Rejected, "expired" => Expired, _ => Unavailable },
        _ => Unavailable,
    };
    public static bool IsFailure(SeatLink link) => link.State is "failed" or "unavailable";
    /// <summary>The one button of a state, null when there is none (linked).</summary>
    public static string? Action(SeatLink link) => link.State switch { "none" => Connect, "waiting" => Cancel, "linked" => null, _ => Again };
    /// <summary>The expiry as the contract asks (JST), e.g. 「17:32まで」.</summary>
    public static string Until(DateTimeOffset expiry) => expiry.ToOffset(TimeSpan.FromHours(9)).ToString("H:mm") + "まで（JST）";
}

public static class SeatLinkApi
{
    private const string Path = "/api/approvals/seat-link";
    public static Task<SeatLink> SeatLinkAsync(this BellApi api, CancellationToken token = default) => Call(() => api.GetAsync<SeatLink>(Path, token), token);
    public static Task<SeatLink> StartSeatLinkAsync(this BellApi api, CancellationToken token = default) => Call(() => api.PostAsync<SeatLink>(Path + "/start", new { }, token), token);
    public static Task<SeatLink> StopSeatLinkAsync(this BellApi api, CancellationToken token = default) => Call(() => api.PostAsync<SeatLink>(Path + "/stop", new { }, token), token);

    // A route that is not there (404), cannot say (503, 403) or a failed read is "unavailable": a plain line and the one button, never an exception into the screen. Cancel passes.
    private static async Task<SeatLink> Call(Func<Task<SeatLink>> call, CancellationToken token)
    {
        try { return await call(); }
        catch (OperationCanceledException) when (token.IsCancellationRequested) { throw; }
        catch (Exception) { return new SeatLink { State = "unavailable" }; }
    }
}
