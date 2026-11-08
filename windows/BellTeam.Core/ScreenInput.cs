using System.Diagnostics;

namespace BellTeam.Core;

// Mac BotScreenKeyBar.swift / BotScreenView.swift: screen input contract docs/architecture/modules/execution/screen-input.md.
public sealed record ScreenApprovalChoice(string Decision, string Label);
public sealed record ScreenApproval
{
    public string Status { get; init; } = "";
    public string? PromptDigest { get; init; }
    public ScreenApprovalChoice[]? Choices { get; init; }
    public bool IsRequired => Status == "approval_required" && PromptDigest is not null && Choices is { Length: > 0 };
    // The banner is rebuilt only when this changes, so a button is never replaced between mouse down and up.
    public string Key => PromptDigest + "\u0001" + string.Join('\u0001', (Choices ?? []).Select(choice => choice.Decision + "\u0002" + choice.Label));
}
public sealed record ScreenKeyAck(string Key);
public sealed record ScreenApprovalAck(string Status);

/// <summary>State of the key bar and approval banner for one Bot's screen view. No automatic retry: every send is one Owner tap.</summary>
public sealed class ScreenInputModel(BellApi api, string botId, Action<Exception, string, string>? report = null, TimeSpan? feedback = null)
{
    public const string UnavailableCode = "SCREEN_INPUT_UNAVAILABLE", SeatAbsentCode = "SCREEN_SEAT_ABSENT", ChangedCode = "SCREEN_APPROVAL_CHANGED", UnsupportedCode = "SCREEN_APPROVAL_UNSUPPORTED", FailedCode = "SCREEN_INPUT_FAILED";
    private readonly TimeSpan feedbackTime = feedback ?? TimeSpan.FromSeconds(1.2);
    private bool approvalFailureReported, retired;
    private CancellationTokenSource? feedbackTask;
    public bool Available { get; private set; } = true;
    public string? SendingKey { get; private set; }
    public string? SentKey { get; private set; }
    public string? Notice { get; private set; }
    public ScreenApproval? Approval { get; private set; }
    public bool ApprovalUnsupported { get; private set; }
    // What the banner shows: an unsupported answer hides it while the keys stay.
    public ScreenApproval? Banner => ApprovalUnsupported ? null : Approval;
    // Every failure the Mac would send to diagnostics: the owner never sees these.
    public int ReportedFailures { get; private set; }
    public event Action? Changed;
    private void Raise() { if (!retired) Changed?.Invoke(); }

    // The screen view closed: later answers of requests already sent change nothing.
    // Render seam: the state right after a key was sent, which a GET-only mock cannot produce.
    public void MarkSentForRender(string id) { SentKey = id; Raise(); }
    public void SetNoticeForRender(string text) { Notice = text; Raise(); }
    public void Retire() { retired = true; feedbackTask?.Cancel(); }

    public async Task SendKeyAsync(string key)
    {
        if (!Available || SendingKey is not null) return;
        SendingKey = key; SentKey = null; Notice = null; Raise();
        try
        {
            await api.PostAsync<ScreenKeyAck>(Path("key"), new { key });
            if (retired) return;
            Succeeded(key);
        }
        catch (Exception error) { await HandleAsync(error, Path("key"), "POST"); }
        finally { SendingKey = null; Raise(); }
    }

    /// <summary>Called on every screen refresh, whatever the last answer was: no state here stops the probing.
    /// A 200 brings the bar back after a 503 and clears an unsupported answer; an unexpected failure is reported once per streak.</summary>
    public async Task RefreshApprovalAsync(CancellationToken token = default)
    {
        try
        {
            var result = await api.GetAsync<ScreenApproval>(Path("approval"), token);
            if (retired) return;
            Available = true; ApprovalUnsupported = false; approvalFailureReported = false;
            Approval = result.IsRequired ? result : null;
        }
        catch (OperationCanceledException) when (token.IsCancellationRequested) { return; }
        catch (BellApiException error) when (Is(error, 503, UnavailableCode)) { Available = false; Approval = null; }
        catch (BellApiException error) when (Is(error, 409, SeatAbsentCode)) { Approval = null; }
        catch (BellApiException error) when (Is(error, 422, UnsupportedCode)) { Approval = null; ApprovalUnsupported = true; }
        catch (BellApiException error) when (error.RequiresLogin) { }
        catch (Exception error)
        {
            if (!approvalFailureReported) { approvalFailureReported = true; Report(error, Path("approval"), "GET"); }
        }
        Raise();
    }

    public async Task RespondAsync(string decision)
    {
        if (!Available || SendingKey is not null || Approval is not { PromptDigest: { } digest }) return;
        SendingKey = "approval:" + decision; Notice = null; Raise();
        try
        {
            await api.PostAsync<ScreenApprovalAck>(Path("approval"), new { decision, promptDigest = digest });
            if (retired) return;
            Approval = null; Succeeded("approval:" + decision);
        }
        catch (Exception error) { await HandleAsync(error, Path("approval"), "POST"); }
        finally { SendingKey = null; Raise(); }
    }

    private void Succeeded(string id)
    {
        SentKey = id; feedbackTask?.Cancel();
        var timer = feedbackTask = new CancellationTokenSource();
        _ = ClearSentAsync(id, timer.Token);
    }
    private async Task ClearSentAsync(string id, CancellationToken token)
    {
        try { await Task.Delay(feedbackTime, token); } catch (OperationCanceledException) { return; }
        if (SentKey == id) { SentKey = null; Raise(); }
    }

    private async Task HandleAsync(Exception error, string path, string method)
    {
        if (retired) return;
        switch (error)
        {
            case BellApiException known when Is(known, 503, UnavailableCode): Available = false; break;
            case BellApiException known when Is(known, 409, ChangedCode): Notice = "画面が変わりました。もう一度確認してください"; Raise(); await RefreshApprovalAsync(); break;
            case BellApiException known when Is(known, 422, UnsupportedCode): Approval = null; ApprovalUnsupported = true; Notice = "キーで答えてください"; break;
            case BellApiException known when Is(known, 409, SeatAbsentCode): Notice = "席が起動していません"; break;
            // Mac maps every 401/403 here; an app 403 (SCREEN_INPUT_OWNER_REQUIRED) no longer counts as a lost sign-in, so name it too.
            case BellApiException known when known.RequiresLogin || known.Status == System.Net.HttpStatusCode.Forbidden: Notice = "オーナーとしてログインしていません"; break;
            case BellApiException known when Is(known, 502, FailedCode): Notice = "送れませんでした"; break;
            default: Notice = "送れませんでした"; Report(error, path, method); break;
        }
    }

    private void Report(Exception error, string path, string method) { ReportedFailures++; (report ?? ((e, p, m) => Trace.TraceError($"{m} {p}: {e.Message}")))(error, path, method); }
    private string Path(string kind) => $"/api/bots/{Uri.EscapeDataString(botId)}/screen/{kind}";
    private static bool Is(BellApiException error, int status, string code) => (int?)error.Status == status && error.Code == code;
}

/// <summary>The full history taken once when the screen opens and the screen tail taken every second afterwards, joined.
/// shortcut: the terminal can scroll between the first history and the first tail, so a few lines may overlap or be missing at the seam; opening the screen again reloads the history.</summary>
public sealed class ScreenScrollback
{
    private string[] history = [];
    private string? prefix;
    public void Start(string full) { history = full.Split('\n'); prefix = null; }
    public string Merge(string tail)
    {
        prefix ??= string.Join('\n', history.Take(history.Length - Math.Min(tail.Split('\n').Length, history.Length)));
        return prefix.Length == 0 ? tail : prefix + "\n" + tail;
    }
}
