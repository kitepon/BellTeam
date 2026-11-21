using System.Net;

namespace BellTeam.Core;

// a485, shape 2 (docs/architecture/modules/usage/app-sessions.md section 2): the app asks its own server to start a login, shows the code the server hands it and polls.
// The app never talks to the operator and never holds a pass; what it keeps is the server's opaque session token (sent as Authorization: Bearer).
// Wire: app-sessions.md section 7b (PR #2206). status: waiting_second_hand | waiting_phone | approved | delivered | refused | expired | cancelled.
public sealed record LoginStatus
{
    public string? LoginId { get; init; }
    public string Status { get; init; } = "";
    public DateTimeOffset? ExpiresAt { get; init; }
    public LoginPhone? Phone { get; init; }
    // The token comes once, on the first poll after approval (or in the console answer); an app that loses it starts a new login.
    public string? Token { get; init; }
    public string? SessionId { get; init; }
    public string? Reason { get; init; }
}
// shortCode and checkNumber are shown exactly as given (leading zeros kept); qr/qrSvg are optional for the app.
public sealed record LoginPhone { public string ShortCode { get; init; } = ""; public string CheckNumber { get; init; } = ""; public string? Qr { get; init; } public string? QrSvg { get; init; } }

public sealed class LoginApi(BellApi api)
{
    public Task<LoginStatus> StartAsync(string kind, CancellationToken token = default) => api.PostAsync<LoginStatus>("/api/login/start", new { kind }, token);
    public Task<LoginStatus> PollAsync(string loginId, CancellationToken token = default) => api.GetAsync<LoginStatus>("/api/login/" + Uri.EscapeDataString(loginId), token);
    // Sign-out (app-sessions.md 7c): DELETE the app's own session; the id is SessionInfo.SessionId from the probe.
    public Task EndSessionAsync(string sessionId, CancellationToken token = default) => api.DeleteAsync("/api/sessions/" + Uri.EscapeDataString(sessionId), token);
    public Task CancelAsync(string loginId, CancellationToken token = default) => api.PostAsync<System.Text.Json.JsonElement>("/api/login/" + Uri.EscapeDataString(loginId) + "/cancel", new { }, token);
    // "use a code from the server console" (section 2a): the answer carries the session token at once.
    public async Task<LoginRequest[]> RequestsAsync(CancellationToken token = default) => (await api.GetAsync<LoginRequestList>("/api/login/requests", token)).Requests;
    public Task ApproveAsync(string loginId, CancellationToken token = default) => api.PostAsync<System.Text.Json.JsonElement>("/api/login/" + Uri.EscapeDataString(loginId) + "/approve", new { }, token);
    public Task DenyAsync(string loginId, CancellationToken token = default) => api.PostAsync<System.Text.Json.JsonElement>("/api/login/" + Uri.EscapeDataString(loginId) + "/deny", new { }, token);
    // 429 LOGIN_RATE_LIMITED when four codes are outstanding (BellApiException.Code).
    public Task<IssuedCode> IssueCodeAsync(CancellationToken token = default) => api.PostAsync<IssuedCode>("/api/login/code", new { }, token);
    public async Task<SessionEntry[]> SessionsAsync(CancellationToken token = default) => (await api.GetAsync<SessionList>("/api/sessions", token)).Sessions;
    public Task<LoginStatus> ConsoleAsync(string code, string kind, CancellationToken token = default) => api.PostAsync<LoginStatus>("/api/login/console", new { code = code.Trim(), kind }, token);
}

// a485 7c, with a session: the requests that wait for this app's hand, the one-time code for "add an app", and the session list. Kept free of UI types (Linux and Android link this file).
public sealed record LoginRequest { public string LoginId { get; init; } = ""; public string Kind { get; init; } = ""; public string NetworkClass { get; init; } = ""; public DateTimeOffset? RequestedAt { get; init; } public DateTimeOffset? ExpiresAt { get; init; } }
public sealed record IssuedCode { public string Code { get; init; } = ""; public DateTimeOffset? ExpiresAt { get; init; } }
// origin: phone | console | added; issuedBy is the issuing session's id for added.
public sealed record SessionEntry { public string Id { get; init; } = ""; public string Kind { get; init; } = ""; public string Origin { get; init; } = ""; public string NetworkClass { get; init; } = ""; public DateTimeOffset? CreatedAt { get; init; } public DateTimeOffset? LastUsedAt { get; init; } public string? IssuedBy { get; init; } public bool Current { get; init; } }
public sealed record LoginRequestList { public LoginRequest[] Requests { get; init; } = []; }
public sealed record SessionList { public SessionEntry[] Sessions { get; init; } = []; }

// The words of the session screens, the same in every app (app-sessions.md 7c, 7e).
public static class SessionText
{
    // 7e: the "add an app" screen, said once under the code.
    public const string AddAppNote = "この画面のコードは1回だけ使えて、10分で切れます。購読していない人は、このコードでブラウザー版に入れます。このコードで入ったものは、このアプリが終わると一緒に終わります。";
    public const string RequestHint = "自分で始めたログインだけ許可してください。";
    public const string CodeLimit = "出したコードが残っています。使うか、切れるまで待ってから、もう一度出してください。";
    public static string RequestTitle(LoginRequest request) => request.Kind + "からのログイン要求";
    public static string Where(string networkClass) => networkClass == "lan" ? "同じネットワークから" : "ネットワークは不明";
    public static string Origin(string origin) => origin switch { "phone" => "スマホで承認", "console" => "サーバーのコードで入った", "added" => "「アプリを追加」のコードで入った", _ => origin };
}

public enum LoginPhase { Starting, WaitingSecondHand, WaitingPhone, Approved, Refused, Failed }

// One login attempt: start once (never resent by itself: the server caps pending logins per peer), then poll every 3 s until approved, refused, expired or cancelled.
// A failed poll is shown and retried on the Core backoff with no attempt limit; the attempt ends at the server's expiresAt.
public sealed class LoginFlow(LoginApi api, string kind, Func<int, CancellationToken, Task>? delay = null, Func<DateTimeOffset>? now = null)
{
    public static readonly TimeSpan PollInterval = TimeSpan.FromSeconds(3);
    // attempt 0 = the next poll; attempt n > 0 = the n-th retry after a failed poll.
    private readonly Func<int, CancellationToken, Task> wait = delay ?? ((attempt, token) => Task.Delay(attempt == 0 ? PollInterval : TimeSpan.FromMilliseconds(ReconnectBackoff.Ms(attempt)), token));
    private readonly Func<DateTimeOffset> clock = now ?? (() => DateTimeOffset.UtcNow);
    private string? loginId;
    public LoginPhase Phase { get; private set; } = LoginPhase.Starting;
    public LoginStatus? Status { get; private set; }
    public string? Token { get; private set; }
    // The plain sentence for Refused and Failed.
    public string? Message { get; private set; }
    public event Action? Changed;

    private void Set(LoginPhase phase, LoginStatus? status = null, string? message = null)
    {
        Phase = phase; if (status is not null) Status = status; Message = message; Changed?.Invoke();
    }

    public static string RefusedText(string? reason) => reason == "not_owner_account"
        ? "このサーバーの持ち主のアカウントではないため、ログインできませんでした。"
        : reason == "second_hand_denied" ? "すでにログインしているアプリで拒否されました。" : reason == "phone_denied" ? "スマートフォンで拒否されました。"
        : "サーバーがログインを断りました。" + (string.IsNullOrWhiteSpace(reason) ? "" : "（" + reason + "）");

    // Returns when the attempt ended (approved, refused, failed or cancelled); Phase says which.
    public async Task RunAsync(CancellationToken token)
    {
        Set(LoginPhase.Starting);
        LoginStatus current;
        try { current = await api.StartAsync(kind, token); }
        catch (OperationCanceledException) when (token.IsCancellationRequested) { return; }
        catch (Exception error) { Set(LoginPhase.Failed, message: "ログインを始められませんでした。" + error.Message); return; }
        if (current.LoginId is null) { Set(LoginPhase.Failed, message: "サーバーからログインの番号を受け取れませんでした。"); return; }
        loginId = current.LoginId;
        var attempt = 0;
        while (true)
        {
            if (Apply(current)) return;
            if (current.ExpiresAt is { } end && clock() >= end) { Set(LoginPhase.Failed, message: "有効期限が切れました。もう一度始めてください。"); return; }
            try { await wait(attempt, token); current = await api.PollAsync(loginId, token); attempt = 0; }
            catch (OperationCanceledException) when (token.IsCancellationRequested) { return; }
            catch (BellApiException missing) when (missing.Status == HttpStatusCode.NotFound) { Set(LoginPhase.Failed, message: "ログインの時間が切れました。もう一度始めてください。"); return; }
            catch (Exception error) { Set(Phase, message: "サーバーの返事を読めませんでした。つなぎ直しています。" + error.Message); attempt++; }
        }
    }

    // True when the attempt is over.
    private bool Apply(LoginStatus status)
    {
        switch (status.Status)
        {
            case "approved" when !string.IsNullOrEmpty(status.Token): Token = status.Token; Set(LoginPhase.Approved, status); return true;
            case "refused": Set(LoginPhase.Refused, status, RefusedText(status.Reason)); return true;
            case "expired": Set(LoginPhase.Failed, status, "ログインの時間が切れました。もう一度始めてください。"); return true;
            case "cancelled": Set(LoginPhase.Failed, status, "取り消しました。"); return true;
            // The token is given once; a later "delivered" without it means this app lost it.
            case "approved" or "delivered": Set(LoginPhase.Failed, status, "承認は済みましたが、この端末はログインの鍵を受け取れませんでした。もう一度始めてください。"); return true;
            case "waiting_phone": Set(LoginPhase.WaitingPhone, status); return false;
            default: Set(LoginPhase.WaitingSecondHand, status); return false;
        }
    }

    public async Task CancelAsync()
    {
        if (loginId is null || Phase is LoginPhase.Approved or LoginPhase.Refused) return;
        try { await api.CancelAsync(loginId); } catch (Exception) { }
    }
}

// The session token the server issued, kept per server address; each app supplies its own safe place (Linux: a 0600 file, Android: Keystore-backed).
public interface ISessionTokenStore
{
    string? Load(Uri origin);
    void Save(Uri origin, string token);
    void Clear(Uri origin);
}
