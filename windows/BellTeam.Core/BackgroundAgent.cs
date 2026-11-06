using System.Text.Json;

namespace BellTeam.Core;

public sealed record BackgroundAgentSelection(string Harness, string Model, string ReasoningEffort);
public sealed record BackgroundAgentState(string? Revision, BackgroundAgentSelection? Selection);
public sealed record BackgroundAgentResponse(BackgroundAgentState BackgroundAgent);

public sealed class BackgroundAgentApi(BellApi api)
{
    public async Task<BackgroundAgentState?> ReadAsync(CancellationToken token = default)
    {
        var json = await api.GetAsync<JsonElement>("/api/settings", token);
        return json.TryGetProperty("backgroundAgent", out var state)
            ? state.Deserialize<BackgroundAgentState>(BellApi.Json) ?? throw new BellApiException("背景エージェントの設定を読み取れませんでした。")
            : null;
    }

    public async Task<BackgroundAgentState> SaveAsync(string? revision, BackgroundAgentSelection selection, CancellationToken token = default)
        => (await api.WriteAsync<BackgroundAgentResponse>(System.Net.Http.HttpMethod.Patch, "/api/settings/backgroundAgent", new { expectedRevision = revision, harness = selection.Harness, model = selection.Model, reasoningEffort = selection.ReasoningEffort }, token)).BackgroundAgent;

    public static bool IsAvailable(BackgroundAgentSelection selection, Dictionary<string, HarnessModels> catalog)
    {
        if (!catalog.TryGetValue(selection.Harness, out var harness) || harness.Error is not null) return false;
        var model = harness.Models.FirstOrDefault(item => item.Id == selection.Model);
        return model is not null && (model.Efforts.Length == 0 ? selection.ReasoningEffort == "" : model.Efforts.Contains(selection.ReasoningEffort));
    }
}
