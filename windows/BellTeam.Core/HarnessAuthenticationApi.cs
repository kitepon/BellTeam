using System.Text.Json.Serialization;

namespace BellTeam.Core;

public sealed record HarnessAuthenticationOption(string Id, string Name, int Members, string? StartWarning, bool? ReloginSupported = null)
{
    public string UsageText => Members > 0 ? $"{Members}人が使用" : "使用していません";
    public bool NeedsStartConfirmation(AuthenticationState? auth) => ReloginSupported != false && !string.IsNullOrEmpty(StartWarning) && auth?.Status != "blocked";
}
public sealed record HarnessAuthenticationsResponse { public required HarnessAuthenticationOption[] Harnesses { get; init; } }
// Slot and account_label are sent for Claude by servers with accounts (harness-accounts contract); absent otherwise.
public sealed record HarnessAuthenticationResponse { public required string Harness { get; init; } public string? Slot { get; init; } [JsonPropertyName("account_label")] public string? AccountLabel { get; init; } public AuthenticationState? Auth { get; init; } }
public sealed class HarnessAuthenticationApi(BellApi api)
{
    public Task<HarnessAuthenticationsResponse> ListAsync(CancellationToken token = default) => api.GetAsync<HarnessAuthenticationsResponse>("/api/harness-auth", token);
    // slot: "2nd" selects the second Claude login through ?slot=; null or "1st" sends the request exactly as before (no slot means 1st). The body never carries the slot.
    public Task<HarnessAuthenticationResponse> StatusAsync(string harness, CancellationToken token = default, string? slot = null) => api.GetAsync<HarnessAuthenticationResponse>(Path(harness, slot), token);
    public Task<HarnessAuthenticationResponse> StartAsync(string harness, CancellationToken token = default, string? slot = null) => WriteAsync(harness, "start", new { }, token, slot);
    public Task<HarnessAuthenticationResponse> CancelAsync(string harness, CancellationToken token = default, string? slot = null) => WriteAsync(harness, "cancel", new { }, token, slot);
    public Task<HarnessAuthenticationResponse> InputAsync(string harness, string? text, string? key, CancellationToken token = default, string? slot = null)
        => WriteAsync(harness, "input", text is null ? new Dictionary<string, string> { ["key"] = key! } : new Dictionary<string, string> { ["text"] = text }, token, slot);
    public Task<HarnessAuthenticationResponse> RespondAsync(string harness, AuthenticationUi ui, object response, CancellationToken token = default, string? slot = null)
        => WriteAsync(harness, "input", new { binding = ui.Binding, prompt_digest = ui.PromptDigest, response }, token, slot);
    private static string Path(string harness, string? slot, string action = "") => "/api/harness-auth/" + Uri.EscapeDataString(harness) + (action.Length == 0 ? "" : "/" + action) + (slot is null or "1st" ? "" : "?slot=" + Uri.EscapeDataString(slot));
    private async Task<HarnessAuthenticationResponse> WriteAsync(string harness, string action, object body, CancellationToken token, string? slot)
    {
        if (action != "input") return await api.PostAsync<HarnessAuthenticationResponse>(Path(harness, slot, action), body, token);
        try { return await api.PostAsync<HarnessAuthenticationResponse>(Path(harness, slot, action), body, token); }
        catch (OperationCanceledException) when (token.IsCancellationRequested) { throw; }
        catch (Exception error) { throw new BellApiException("操作の結果を確認できませんでした。入力欄を閉じて、認証の状態を更新して確認してください。", (error as BellApiException)?.Status); }
    }
}
