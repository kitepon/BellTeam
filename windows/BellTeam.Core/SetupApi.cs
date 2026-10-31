using System.Text.Json.Serialization;

namespace BellTeam.Core;

public sealed record HarnessOption(string Id, string Name);
public sealed record AuthenticationState
{
    public required string Status { get; init; }
    public string? Url { get; init; }
    [JsonPropertyName("user_code")] public string? UserCode { get; init; }
    [JsonPropertyName("input_required")] public bool InputRequired { get; init; }
    public string? Message { get; init; }
    [JsonPropertyName("auth_ui")] public AuthenticationUi? AuthUi { get; init; }
}
public sealed record AuthenticationBinding(
    [property: JsonPropertyName("session_id")] string SessionId,
    [property: JsonPropertyName("launch_id")] string? LaunchId);
public sealed record AuthenticationChoice(string Id, string Label);
public sealed record AuthenticationUi
{
    public string? Schema { get; init; }
    public string? Stage { get; init; }
    public string? Title { get; init; }
    public string? Message { get; init; }
    public string? Url { get; init; }
    [JsonPropertyName("user_code")] public string? UserCode { get; init; }
    public string? Input { get; init; }
    [JsonPropertyName("prompt_digest")] public string? PromptDigest { get; init; }
    public AuthenticationBinding? Binding { get; init; }
    public AuthenticationChoice[] Choices { get; init; } = [];
    [JsonIgnore] public bool CanRespond => Schema == "aiterm.auth-ui.v1" && Binding is not null && !string.IsNullOrEmpty(PromptDigest);
    public bool Equals(AuthenticationUi? other) => other is not null && Schema == other.Schema && Stage == other.Stage
        && Title == other.Title && Message == other.Message && Url == other.Url && UserCode == other.UserCode
        && Input == other.Input && PromptDigest == other.PromptDigest && Binding == other.Binding
        && (Choices ?? []).SequenceEqual(other.Choices ?? []);
    public override int GetHashCode() => HashCode.Combine(Schema, Stage, PromptDigest, Binding);
}
public sealed record SetupState
{
    public required string Phase { get; init; }
    public string? Harness { get; init; }
    public required HarnessOption[] Harnesses { get; init; }
    public string? GuideBotId { get; init; }
    public required bool Complete { get; init; }
    public AuthenticationState? Auth { get; init; }
}
public sealed class SetupApi(BellApi api)
{
    public Task<SetupState> StatusAsync(CancellationToken token = default) => api.GetAsync<SetupState>("/api/setup", token);
    public Task<SetupState> SelectAsync(string harness, CancellationToken token = default) => api.PostAsync<SetupState>("/api/setup/harness", new { harness }, token);
    public Task<SetupState> InputAsync(string? text, string? key, CancellationToken token = default) => PostAsync("/api/setup/auth/input", text is null ? new Dictionary<string, string> { ["key"] = key! } : new Dictionary<string, string> { ["text"] = text }, token);
    public Task<SetupState> RespondAsync(AuthenticationUi ui, object response, CancellationToken token = default)
        => PostAsync("/api/setup/auth/input", new { binding = ui.Binding, prompt_digest = ui.PromptDigest, response }, token);
    public Task<SetupState> StartAsync(CancellationToken token = default) => api.PostAsync<SetupState>("/api/setup/start", new { }, token);
    private async Task<SetupState> PostAsync(string path, object body, CancellationToken token)
    {
        try { return await api.PostAsync<SetupState>(path, body, token); }
        catch (OperationCanceledException) when (token.IsCancellationRequested) { throw; }
        catch (Exception error) { throw new BellApiException("操作の結果を確認できませんでした。入力欄を閉じて、認証の状態を更新して確認してください。", (error as BellApiException)?.Status); }
    }
}
