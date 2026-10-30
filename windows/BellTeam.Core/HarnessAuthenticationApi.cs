namespace BellTeam.Core;

public sealed record HarnessAuthenticationOption(string Id, string Name, int Members, string? StartWarning, bool? ReloginSupported = null)
{
    public string UsageText => Members > 0 ? $"{Members}人が使用" : "使用していません";
    public bool NeedsStartConfirmation(AuthenticationState? auth) => !string.IsNullOrEmpty(StartWarning) && auth?.Status != "blocked";
}
public sealed record HarnessAuthenticationsResponse { public required HarnessAuthenticationOption[] Harnesses { get; init; } }
public sealed record HarnessAuthenticationResponse { public required string Harness { get; init; } public AuthenticationState? Auth { get; init; } }
public sealed class HarnessAuthenticationApi(BellApi api)
{
    public Task<HarnessAuthenticationsResponse> ListAsync(CancellationToken token = default) => api.GetAsync<HarnessAuthenticationsResponse>("/api/harness-auth", token);
    public Task<HarnessAuthenticationResponse> StatusAsync(string harness, CancellationToken token = default) => api.GetAsync<HarnessAuthenticationResponse>(Path(harness), token);
    public Task<HarnessAuthenticationResponse> StartAsync(string harness, CancellationToken token = default) => WriteAsync(harness, "start", new { }, token);
    public Task<HarnessAuthenticationResponse> CancelAsync(string harness, CancellationToken token = default) => WriteAsync(harness, "cancel", new { }, token);
    public Task<HarnessAuthenticationResponse> InputAsync(string harness, string? text, string? key, CancellationToken token = default)
        => WriteAsync(harness, "input", text is null ? new Dictionary<string, string> { ["key"] = key! } : new Dictionary<string, string> { ["text"] = text }, token);
    private static string Path(string harness) => "/api/harness-auth/" + Uri.EscapeDataString(harness);
    private async Task<HarnessAuthenticationResponse> WriteAsync(string harness, string action, object body, CancellationToken token)
    {
        if (action != "input") return await api.PostAsync<HarnessAuthenticationResponse>(Path(harness) + "/" + action, body, token);
        try { return await api.PostAsync<HarnessAuthenticationResponse>(Path(harness) + "/" + action, body, token); }
        catch (OperationCanceledException) when (token.IsCancellationRequested) { throw; }
        catch (Exception error) { throw new BellApiException("操作の結果を確認できませんでした。入力欄を閉じて、認証の状態を更新して確認してください。", (error as BellApiException)?.Status); }
    }
}
