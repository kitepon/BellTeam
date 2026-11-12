using System.Globalization;
using System.Text.Json;

namespace BellTeam.Core;

public sealed record GoalChangeResult(bool Confirmed, GoalSnapshot Snapshot);

// Server wire (src/http-goal-api.mjs): GET /api/goals -> { goals: [snapshot] }; GET /api/bots/{id}/goal -> { snapshot };
// POST /api/bots/{id}/goal { action: create|edit|pause|resume|clear, binding, objective?, tokenBudget? } -> 200 | 202 { outcome: confirmed|unconfirmed, snapshot }.
// There is no PUT or DELETE route: every write is one POST.
public sealed class GoalsApi(BellApi api)
{
    public async Task<GoalSnapshot[]> ListAsync(CancellationToken token = default) => GoalParser.ParseList(await api.GetAsync<JsonElement>("/api/goals", token));
    public async Task<GoalSnapshot> InspectAsync(string botId, CancellationToken token = default) => GoalParser.ParseDetail(await api.GetAsync<JsonElement>(Path(botId), token));
    public async Task<GoalChangeResult> ChangeAsync(string botId, string action, GoalBinding binding, string? objective, long? tokenBudget, CancellationToken token = default)
    {
        // Mac encodes the optionals with encodeIfPresent: a missing objective or budget is left out, never null.
        var body = new Dictionary<string, object?> { ["action"] = action, ["binding"] = binding };
        if (objective is not null) body["objective"] = objective;
        if (tokenBudget is not null) body["tokenBudget"] = tokenBudget;
        var root = await api.PostAsync<JsonElement>(Path(botId), body, token);
        if (root.ValueKind != JsonValueKind.Object || !root.TryGetProperty("outcome", out var outcome) || outcome.ValueKind != JsonValueKind.String || outcome.GetString() is not ("confirmed" or "unconfirmed")) throw new BellApiException("BellTeamからの応答を読み取れませんでした。（outcome）");
        return new GoalChangeResult(outcome.GetString() == "confirmed", GoalParser.ParseDetail(root));
    }
    private static string Path(string botId) => $"/api/bots/{Uri.EscapeDataString(botId)}/goal";
}

public sealed class GoalChangeException(string message) : Exception(message);

// Mac GoalViewModel: one per page and one per open member conversation. Reads never overlap a write; a write is sent once and never resent.
public sealed class GoalModel(GoalsApi api)
{
    public IReadOnlyList<GoalSnapshot> Snapshots { get; private set; } = [];
    public bool Loading { get; private set; }
    public bool Loaded { get; private set; }
    public bool Mutating { get; private set; }
    public bool NeedsRefresh { get; private set; }
    public string? ErrorText { get; private set; }
    // Why the last read failed, for the folded 詳細 only (the Mac sends it to diagnostics); a read that works clears it.
    public string? ReadError { get; private set; }
    public event Action? Changed;
    public IReadOnlyList<GoalSnapshot> CurrentSnapshots => NeedsRefresh ? [] : Snapshots;
    public GoalSnapshot? CurrentSnapshot(string botId) => CurrentSnapshots.FirstOrDefault(item => item.BotId == botId);
    public bool Busy => Loading || Mutating || NeedsRefresh;
    private void Notify() => Changed?.Invoke();

    public Task LoadListAsync(CancellationToken token = default) => LoadAsync(null, token);
    public Task LoadDetailAsync(string botId, CancellationToken token = default) => LoadAsync(botId, token);
    private async Task LoadAsync(string? botId, CancellationToken token)
    {
        if (Loading || Mutating) return;
        Loading = true; Notify();
        try
        {
            token.ThrowIfCancellationRequested();
            if (botId is null) Snapshots = await api.ListAsync(token);
            else
            {
                var snapshot = await api.InspectAsync(botId, token);
                if (snapshot.BotId != botId) throw new GoalChangeException(Invalid);
                Snapshots = [snapshot];
            }
            token.ThrowIfCancellationRequested();
            Loaded = true; NeedsRefresh = false; ErrorText = null; ReadError = null;
        }
        catch (Exception) when (token.IsCancellationRequested) { }
        catch (BellApiException login) when (login.RequiresLogin) { }
        catch (Exception error)
        {
            // A failed read hides the cards (they may be stale) until the next read succeeds; the next event or refresh reads again.
            // ErrorText keeps only a change's own sentence (an outcome not known must not be lost); the read failure is the plain 確認できません state (Mac #1116).
            NeedsRefresh = true; ReadError = error.Message;
        }
        finally { Loading = false; Notify(); }
    }

    private void Replace(GoalSnapshot snapshot)
    {
        var list = Snapshots.ToList();
        var index = list.FindIndex(item => item.BotId == snapshot.BotId);
        if (index >= 0) list[index] = snapshot; else list.Add(snapshot);
        Snapshots = list;
    }

    // A card button: the failure is shown on the page (ErrorText), never thrown.
    public async Task RunAsync(GoalSnapshot snapshot, string action)
    {
        try { await ChangeAsync(snapshot, action); }
        catch (BellApiException login) when (login.RequiresLogin) { }
        catch (Exception error) { ErrorText = error.Message; Notify(); }
    }

    private const string Invalid = "ゴールの応答を確認できませんでした。更新して確認してください。";
    public async Task ChangeAsync(GoalSnapshot snapshot, string action, string? objective = null, long? tokenBudget = null)
    {
        if (Loading) throw new GoalChangeException("ゴールの更新が終わってから保存してください。");
        if (Mutating || NeedsRefresh) throw new GoalChangeException("変更結果を確認できませんでした。現在の状態を確認してから操作してください。");
        var current = Snapshots.FirstOrDefault(item => item.BotId == snapshot.BotId);
        if (current is null || snapshot.Binding is not { } binding || current.Binding != binding) throw new GoalChangeException("会話が変わりました。現在のゴールを更新してから操作してください。");
        Mutating = true; Notify();
        try
        {
            GoalChangeResult response;
            try { response = await api.ChangeAsync(snapshot.BotId, action, binding, objective, tokenBudget); }
            catch (BellApiException login) when (login.RequiresLogin) { throw; }
            catch (Exception)
            {
                // The result of the write is unknown: read the state back once and say so. The write itself is not repeated.
                GoalSnapshot latest;
                try { latest = await api.InspectAsync(snapshot.BotId); }
                catch (Exception) { NeedsRefresh = true; throw new GoalChangeException("変更結果と現在の状態を確認できませんでした。更新して確認してください。"); }
                if (latest.BotId != snapshot.BotId) { NeedsRefresh = true; throw new GoalChangeException(Invalid); }
                Replace(latest);
                throw new GoalChangeException("変更の応答を確認できませんでした。現在取得できた状態を表示しています。操作前に確認してください。");
            }
            if (response.Snapshot.BotId != snapshot.BotId) { NeedsRefresh = true; throw new GoalChangeException(Invalid); }
            Replace(response.Snapshot);
            if (!response.Confirmed) { NeedsRefresh = true; throw new GoalChangeException("変更結果を確認できませんでした。現在の状態を確認してから操作してください。"); }
            ErrorText = null;
        }
        finally { Mutating = false; Notify(); }
    }
}

// Mac GoalEditor state and rules (which fields the sheet shows, when 保存 is enabled, what a save sends).
public enum GoalEditField { Objective, Budget }

public sealed class GoalEditorModel(GoalSnapshot selection, string action, string harness)
{
    public const int ObjectiveLimit = 4000;
    public string Objective { get; set; } = selection.Goal?.Objective ?? "";
    public string Budget { get; set; } = selection.Goal?.TokenBudget?.ToString(CultureInfo.InvariantCulture) ?? "";
    public GoalEditField Field { get; set; } = GoalEditField.Objective;
    public bool BudgetChanged { get; set; }
    public string Action => action;
    public string BotId => selection.BotId;
    public GoalSnapshot Selection => selection;
    public int ObjectiveCount => new StringInfo(Objective).LengthInTextElements;
    public string CountText => $"{ObjectiveCount} / {ObjectiveLimit}";
    public bool CodexResetNote(GoalSnapshot? current) => action == "edit" && harness == "codex" && EditsObjective(current);
    public GoalFields? Fields(GoalSnapshot? current) => current is null ? null : action == "create" ? current.FieldCapabilities.Create : current.FieldCapabilities.Edit;
    public bool BindingChanged(GoalSnapshot? current) => current?.Binding != selection.Binding;
    public bool SeparateChoice(GoalSnapshot? current) => Fields(current) is { Objective: true, TokenBudget: true, Combined: false };
    public bool EditsObjective(GoalSnapshot? current) => Fields(current) is { Objective: true } && (!SeparateChoice(current) || Field == GoalEditField.Objective);
    public bool EditsBudget(GoalSnapshot? current) => Fields(current) is { TokenBudget: true } && (!SeparateChoice(current) || Field == GoalEditField.Budget);
    public bool CanSave(GoalSnapshot? current, bool saving, bool refreshing)
    {
        if (saving || refreshing || BindingChanged(current) || current?.Availability != GoalAvailability.Available
            || (action == "create" ? current.Capabilities.Create : current.Capabilities.Edit) != true) return false;
        if (EditsObjective(current))
        {
            var value = Objective.Trim();
            return value.Length != 0 && ObjectiveCount <= ObjectiveLimit;
        }
        return EditsBudget(current) && BudgetChanged && ParseBudget(Budget) is > 0;
    }
    // Swift Int(text): optional sign and digits only, no spaces.
    public static long? ParseBudget(string text) => long.TryParse(text, NumberStyles.AllowLeadingSign, CultureInfo.InvariantCulture, out var value) ? value : null;
    // What a save sends, or the message to show before anything is sent.
    public (string? Objective, long? TokenBudget, string? Error) Prepare(GoalSnapshot? current)
    {
        var objective = EditsObjective(current) ? Objective.Trim() : null;
        long? budget = null;
        if (EditsBudget(current) && BudgetChanged && Budget.Length != 0)
        {
            var parsed = ParseBudget(Budget);
            if (parsed is not > 0) return (null, null, "トークン予算は1以上の整数で入力してください。");
            budget = parsed;
        }
        return (objective, budget, null);
    }
}

// Mac eventRevision: which server events make an open goal view read again.
public static class GoalEvents
{
    private static readonly HashSet<string> Quiet = ["updates", "settings", "setup", "ai-control", "bots"];
    private static readonly HashSet<string> Topics = ["timeline", "queue", "bots", "rooms", "owner", "settings", "requests", "questions", "ai-control", "setup", "schedules", "updates"];
    private static readonly HashSet<string> Scoped = ["timeline", "queue", "requests", "questions", "schedules"];
    public static bool ShouldReload(JsonElement item, bool refreshFailing)
    {
        var type = item.ValueKind == JsonValueKind.Object && item.TryGetProperty("type", out var value) && value.ValueKind == JsonValueKind.String ? value.GetString() : null;
        if (type is not null && Quiet.Contains(type)) return false;
        return type != "messages" || !Targeted(item) || refreshFailing;
    }
    // A "messages" event limited to some topics and Bots or rooms; any other shape counts as "everything changed".
    private static bool Targeted(JsonElement item)
    {
        if (!item.TryGetProperty("all", out var all) || all.ValueKind != JsonValueKind.False) return false;
        if (!Strings(item, "topics", out var topics) || topics.Length == 0 || !Strings(item, "botIds", out var bots) || !Strings(item, "roomIds", out var rooms)) return false;
        if (bots.Concat(rooms).Any(id => id.Length == 0) || topics.Distinct().Count() != topics.Length || !topics.All(Topics.Contains)) return false;
        return !topics.Any(Scoped.Contains) || bots.Length != 0 || rooms.Length != 0;
    }
    private static bool Strings(JsonElement item, string name, out string[] values)
    {
        values = [];
        if (!item.TryGetProperty(name, out var array) || array.ValueKind != JsonValueKind.Array || array.EnumerateArray().Any(entry => entry.ValueKind != JsonValueKind.String)) return false;
        values = [.. array.EnumerateArray().Select(entry => entry.GetString()!)]; return true;
    }
}
