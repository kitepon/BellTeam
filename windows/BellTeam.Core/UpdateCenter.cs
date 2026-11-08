using System.Text.Json;

namespace BellTeam.Core;

public sealed record UpdateVersion(string Version, string? SourceCommit, string? Digest, string Origin);
public sealed record UpdateCapability(bool Supported, string? Reason);
public sealed record UpdateAvailability(bool? Available, string? Reason);
public sealed record UpdateComparison(string State, string? Reason);
public sealed record UpdateNotice(string State, string? Code, string Message);
public sealed record UpdateTarget(string ComponentId, UpdateVersion? Current, UpdateVersion Published);
public sealed record UpdateCompatibility(bool Compatible, string? Reason);
public sealed record UpdateImpact(bool ContainerRestart, string Description);
public sealed record UpdatePlan(Guid PlanId, string Scope, string? ComponentId, DateTimeOffset ExpiresAt, UpdateTarget[] Targets, UpdateCompatibility Compatibility, UpdateImpact Impact, UpdateCapability Capability, string? Action);
public sealed record UpdateError(string Code, string Message);
public sealed record UpdateJobTarget(string ModuleId);
public sealed record UpdateJob(string JobId, string Kind, UpdateJobTarget Target, string State, UpdateError? Reason);
public sealed record UpdateOperation(Guid RequestId, UpdatePlan Plan, string Admission, string Phase, string Execution, string Verification, UpdateError? Error, string? Reference, UpdateJob[]? Jobs = null);
public sealed record UpdateLatestJob(string JobId, string Kind, string State, string Outcome, string At, UpdateError? Reason);
public sealed record UpdatePartStatus(string Line, string Tone, bool ActionRequired, string? Action, UpdateLatestJob? LatestJob);
public sealed record UpdateLastExit(int? Code, string? Signal);
public sealed record UpdateProblem(string Fingerprint, string Status, string Kind, string ModuleId, int Count, int WindowSeconds, UpdateLastExit LastExit, string LastReason);
// Status is read leniently (like the Mac LenientField): an unreadable per-part status only drops that part's status line.
public sealed record UpdateComponent(string Id, string Name, string Description, UpdateVersion? Current, UpdateVersion? Published, UpdateComparison Comparison, string[] Changes, UpdateCapability Capability, UpdateAvailability Availability, JsonElement Publication, JsonElement Status = default)
{
    public UpdatePartStatus? Part
    {
        get
        {
            if (Status.ValueKind != JsonValueKind.Object) return null;
            try { var value = Status.Deserialize<UpdatePartStatus>(BellApi.Json); return value is not null && value.Tone is "ok" or "updating" or "attention" && value.Line is not null ? value : null; }
            catch (JsonException) { return null; }
        }
    }
    public string? PublishedAt => Publication.ValueKind == JsonValueKind.Object && Publication.TryGetProperty("catalog", out var catalog) && catalog.ValueKind == JsonValueKind.Object && catalog.TryGetProperty("publishedAt", out var at) && at.ValueKind == JsonValueKind.String ? at.GetString() : null;
}
public sealed record UpdateCandidate(string ComponentId, string Id);
public sealed record UpdateNotificationSeen(string Server, string ComponentId, string Id);
public sealed record UpdateInventory(string Schema, UpdateNotice Notice, UpdateComponent[] Components, UpdatePlan[] Plans, UpdateOperation? Operation, UpdateOperation? PreviousOperation, UpdateCandidate[]? NotificationCandidates = null, UpdateJob[]? Jobs = null, UpdateProblem[]? Problems = null);
public sealed record UpdatePlanResponse(UpdatePlan Plan);
public sealed record UpdateOperationResponse(UpdateOperation Operation);
public sealed record UpdateRequest(string Server, Guid RequestId, Guid PlanId, UpdateOperation? Result, string? Rejection = null);

public sealed class UpdateCenter(BellApi api, SettingsStore store)
{
    public string Server => api.Origin.AbsoluteUri;
    public UpdateRequest[] Requests => store.Load().UpdateRequests.Where(item => item.Server == Server).ToArray();
    public async Task<UpdateInventory> InventoryAsync(CancellationToken token = default)
    {
        var value = await api.GetAsync<UpdateInventory>("/api/updates", token);
        if (value.Schema != "bellteam.updates.v1" || value.Notice is null || value.Notice.State is not ("ready" or "unavailable" or "updating" or "attention") || string.IsNullOrEmpty(value.Notice.Message) || value.Components is null || value.Plans is null || value.Components.Any(item => item is null || string.IsNullOrEmpty(item.Id) || string.IsNullOrEmpty(item.Name) || item.Comparison is null || item.Comparison.State is not ("up_to_date" or "update_available" or "unavailable" or "incompatible" or "unknown") || item.Changes is null || item.Capability is null || item.Availability is null)) throw new BellApiException("更新情報の応答形式を確認できません。");
        return value;
    }
    public async Task<UpdatePlan> PlanAsync(string? componentId, CancellationToken token = default)
    {
        object request = componentId is null ? new { scope = "all" } : new { scope = "component", componentId };
        var response = await api.PostAsync<JsonElement>("/api/updates/plans", request, token);
        if (!response.TryGetProperty("plan", out var json)) throw new BellApiException("更新計画の応答形式を確認できません。");
        var plan = DecodePlan(json);
        if (plan.Scope != (componentId is null ? "all" : "component") || plan.ComponentId != componentId || plan.Action is not (null or "update") || plan.Scope == "component" && (plan.Targets.Length != 1 || plan.Targets[0].ComponentId != componentId)) throw new BellApiException("更新計画の対象を確認できません。");
        if (Requests.Any(item => item.PlanId == plan.PlanId && (item.Result is null && item.Rejection is null || item.Result?.Admission == "unknown" || item.Result?.Phase == "unknown"))) throw new BellApiException("結果が不明な要求と同じ計画は実行できません。元の要求を照会するか、新しい計画を取得してください。");
        return plan;
    }
    private static UpdatePlan DecodePlan(JsonElement json)
    {
        static bool BooleanField(JsonElement value, string key) => value.ValueKind == JsonValueKind.Object && value.TryGetProperty(key, out var field) && field.ValueKind is JsonValueKind.True or JsonValueKind.False;
        if (json.ValueKind != JsonValueKind.Object || !json.TryGetProperty("impact", out var impact) || !BooleanField(impact, "containerRestart") || !json.TryGetProperty("compatibility", out var compatibility) || !BooleanField(compatibility, "compatible") || !json.TryGetProperty("capability", out var capability) || !BooleanField(capability, "supported")) throw new BellApiException("更新計画の応答形式を確認できません。");
        var plan = json.Deserialize<UpdatePlan>(BellApi.Json);
        if (plan is null || plan.PlanId == Guid.Empty || plan.Targets is null || plan.Targets.Length == 0 || plan.Targets.Any(target => target is null || string.IsNullOrEmpty(target.ComponentId) || target.Published is null || string.IsNullOrEmpty(target.Published.Version)) || plan.Compatibility is null || plan.Impact is null || string.IsNullOrEmpty(plan.Impact.Description) || plan.Capability is null) throw new BellApiException("更新計画の応答形式を確認できません。");
        return plan;
    }
    public async Task<UpdateOperation> StartAsync(UpdatePlan plan, bool confirmed, CancellationToken token = default)
    {
        if (!plan.Capability.Supported || !plan.Compatibility.Compatible || plan.ExpiresAt <= DateTimeOffset.UtcNow || plan.Impact.ContainerRestart && !confirmed) throw new BellApiException("更新計画を確認し、必要な再起動への同意を行ってください。");
        var request = new UpdateRequest(Server, Guid.NewGuid(), plan.PlanId, null);
        Save(request);
        UpdateOperation result;
        try { result = (await api.PostAsync<UpdateOperationResponse>("/api/updates/operations", new { planId = plan.PlanId, requestId = request.RequestId, confirmContainerRestart = plan.Impact.ContainerRestart && confirmed }, token)).Operation; }
        catch (BellApiException error) when ((int?)error.Status is 400 or 401 or 403 or 404 or 409)
        {
            Save(request with { Rejection = error.Message });
            throw new BellApiException("更新は受け付けられませんでした。" + error.Message, error.Status);
        }
        catch (Exception error) { throw new BellApiException($"受付を確認できません。要求ID {request.RequestId} の結果を照会してください。更新は自動で再送しません。{error.Message}"); }
        return SaveResult(request, result);
    }
    public async Task<UpdateOperation> ReadAsync(UpdateRequest request, CancellationToken token = default)
    {
        var result = (await api.GetAsync<UpdateOperationResponse>($"/api/updates/operations/{request.RequestId:D}", token)).Operation;
        return SaveResult(request, result);
    }
    private UpdateOperation SaveResult(UpdateRequest request, UpdateOperation result)
    {
        if (result is null || result.RequestId != request.RequestId || result.Plan is null || result.Plan.PlanId != request.PlanId || result.Admission is not ("accepted" or "rejected" or "unknown") || result.Phase is not ("preparing" or "applying" or "reconnecting" or "verifying" or "completed" or "failed" or "unknown") || result.Execution is not ("pending" or "succeeded" or "failed" or "unknown") || result.Verification is not ("pending" or "succeeded" or "failed" or "unknown") || result.Phase == "completed" && (result.Admission != "accepted" || result.Execution != "succeeded" || result.Verification != "succeeded")) throw new BellApiException("同じ更新要求の結果を確認できません。再送せずに照会してください。");
        var previous = Requests.FirstOrDefault(item => item.RequestId == request.RequestId)?.Result;
        if (previous is not null && Terminal(previous) && !Terminal(result)) return previous;
        Save(request with { Result = result });
        return result;
    }
    private static bool Terminal(UpdateOperation result) => result.Admission == "rejected" || result.Phase == "completed" || result.Phase == "failed" && result.Execution == "failed";
    private void Save(UpdateRequest request)
    {
        var settings = store.Load();
        store.Save(settings with { UpdateRequests = settings.UpdateRequests.Where(item => item.Server != request.Server || item.RequestId != request.RequestId).Append(request).ToArray() });
    }
}
