using System.Net.Http;
using System.Text.Json;

namespace BellTeam.Core;

public sealed class PlanningApi(BellApi api)
{
    public Task<SchedulesResponse> SchedulesAsync(ChatTarget target, CancellationToken token = default) => api.GetAsync<SchedulesResponse>(target.Path + "/schedules", token);
    public async Task<ScheduleSource[]> AllSchedulesAsync(IEnumerable<(ChatTarget Target, string Name)> owners, CancellationToken token = default)
    {
        try
        {
            var response = await api.GetAsync<AllSchedulesResponse>("/api/schedules", token);
            if (response.Sources is null || response.Sources.Any(source => source is null || source.Kind is not ("bot" or "room") || string.IsNullOrEmpty(source.Id) || source.Name is null || source.Schedules is null))
                throw new BellApiException("予定の一覧を読み取れませんでした。");
            return response.Sources;
        }
        catch (BellApiException error) when (error.Status == System.Net.HttpStatusCode.NotFound)
        {
            return await Task.WhenAll(owners.Select(async owner => new ScheduleSource { Kind = owner.Target.IsRoom ? "room" : "bot", Id = owner.Target.Id, Name = owner.Name, Schedules = (await SchedulesAsync(owner.Target, token)).Schedules }));
        }
    }
    public Task<ScheduleResponse> SaveScheduleAsync(ChatTarget target, string? id, Dictionary<string, object?> body, CancellationToken token = default)
        => api.WriteAsync<ScheduleResponse>(id is null ? HttpMethod.Post : HttpMethod.Put, target.Path + "/schedules" + (id is null ? "" : "/" + Uri.EscapeDataString(id)), body, token);
    public Task DeleteScheduleAsync(ScheduledEntry entry, CancellationToken token = default) => api.DeleteAsync(entry.Path, token);
    public Task<JsonElement> RunScheduleAsync(ScheduledEntry entry, CancellationToken token = default) => api.PostAsync<JsonElement>(entry.Path + "/run", new { }, token);
    public Task<OwnerResponse> OwnerAsync(CancellationToken token = default) => api.GetAsync<OwnerResponse>("/api/owner", token);
    public Task<OwnerResponse> SaveOwnerAsync(Dictionary<string, object?> changes, CancellationToken token = default) => api.WriteAsync<OwnerResponse>(HttpMethod.Patch, "/api/owner", changes, token);
    public Task<UserRulesResponse> RulesAsync(CancellationToken token = default) => api.GetAsync<UserRulesResponse>("/api/user-rules", token);
    public Task<UserRulesResponse> SaveRulesAsync(string text, CancellationToken token = default) => api.WriteAsync<UserRulesResponse>(HttpMethod.Put, "/api/user-rules", new { text = TextContent.Normalize(text) }, token);
    public async Task<FeatureSetting[]> FeaturesAsync(CancellationToken token = default)
    {
        try { return (await api.GetAsync<JsonElement>("/api/settings", token)).GetProperty("settings").EnumerateArray().Select(FeatureSetting.Read).ToArray(); }
        catch (Exception) { throw new BellApiException("追加機能の設定を読み取れませんでした。接続と認証を確認してください。"); }
    }
    public async Task<FeatureSetting> SaveFeatureAsync(string id, bool? enabled, Dictionary<string, string> values, CancellationToken token = default)
    {
        try
        {
            var body = new Dictionary<string, object?> { ["values"] = values };
            if (enabled is not null) body["enabled"] = enabled.Value;
            var result = await api.WriteAsync<JsonElement>(HttpMethod.Patch, "/api/settings/" + Uri.EscapeDataString(id), body, token);
            return FeatureSetting.Read(result.GetProperty("setting"));
        }
        catch (Exception) { throw new BellApiException("設定の保存・反映結果を確認できませんでした。閉じて最新の状態を確認してください。"); }
    }
}
