using System.Globalization;
using System.Text.Json;

namespace BellTeam.Core;

// Mac Core/GoalModels.swift. The wire mixes camelCase (snapshot, Codex) and snake_case (Claude and Grok native states);
// Mac decodes with convertFromSnakeCase, so a key is looked up in both spellings. Unknown extra fields are ignored.
public enum GoalAvailability { Available, Unsupported, Unavailable }

public sealed record GoalCapabilities(bool Inspect, bool Create, bool Edit, bool Pause, bool Resume, bool Clear);
public sealed record GoalFields(bool Objective, bool TokenBudget, bool Combined);
public sealed record GoalFieldCapabilities(GoalFields Create, GoalFields Edit);
public sealed record GoalBinding(string SessionId, string LaunchId, string ThreadId);

public static class GoalText
{
    public static string Number(double value) => value.ToString("#,##0.###", CultureInfo.CurrentCulture);
    public static string Date(string text) => DateTimeOffset.TryParse(text, CultureInfo.InvariantCulture, DateTimeStyles.RoundtripKind, out var at) ? at.ToLocalTime().ToString(CoreStrings.GoalModels_Date_1, CultureInfo.CurrentCulture) : text;
    public static string StatusTitle(string status) => status switch
    {
        "active" => CoreStrings.GoalModels_StatusTitle_1, "paused" => CoreStrings.GoalModels_StatusTitle_2, "blocked" => CoreStrings.GoalModels_StatusTitle_3,
        "usageLimited" => CoreStrings.GoalModels_StatusTitle_4, "budgetLimited" => CoreStrings.GoalModels_StatusTitle_5, "complete" => CoreStrings.GoalModels_StatusTitle_6, _ => status
    };
}

public abstract record NativeGoal
{
    public abstract string Objective { get; }
    public virtual long? TokenBudget => null;
    public abstract string StatusTitle { get; }
    public abstract bool IsActive { get; }
    public virtual bool IsPaused => false;
    public abstract string UsageText { get; }
    public abstract string? ElapsedText { get; }
}

public sealed record CodexGoal(string Text, string Status, long? Budget, long TokensUsed, double TimeUsedSeconds) : NativeGoal
{
    public override string Objective => Text;
    public override long? TokenBudget => Budget;
    public override string StatusTitle => GoalText.StatusTitle(Status);
    public override bool IsActive => Status == "active";
    public override bool IsPaused => Status == "paused";
    public override string UsageText => CoreStrings.GoalModels_UsageText_2(GoalText.Number(TokensUsed), (Budget is { } budget ? GoalText.Number(budget) : CoreStrings.GoalModels_UsageText_1), GoalText.Number(TimeUsedSeconds));
    public override string? ElapsedText => CoreStrings.GoalModels_ElapsedText_1(GoalText.Number(TimeUsedSeconds));
}

public sealed record ClaudeGoalStatus(string Type, string Condition, bool Met, bool? Sentinel, long? Tokens, double? DurationMs, long? Iterations);

public sealed record ClaudeGoal(ClaudeGoalStatus Native, long? ReportedTurns) : NativeGoal
{
    public override string Objective => Native.Condition;
    public override string StatusTitle => CoreStrings.GoalModels_StatusTitle_1;
    public override bool IsActive => true;
    public override string UsageText
    {
        get
        {
            var parts = new List<string>();
            if (Native.Tokens is { } tokens) parts.Add(CoreStrings.GoalModels_UsageText_3(GoalText.Number(tokens)));
            if (Native.DurationMs is { } duration) parts.Add(CoreStrings.GoalModels_UsageText_4(GoalText.Number(duration)));
            if (Native.Iterations is { } iterations) parts.Add(CoreStrings.GoalModels_UsageText_5(GoalText.Number(iterations)));
            if (ReportedTurns is { } turns) parts.Add(CoreStrings.GoalModels_UsageText_6(GoalText.Number(turns)));
            return parts.Count == 0 ? CoreStrings.GoalModels_UsageText_7 : string.Join(" · ", parts);
        }
    }
    public override string? ElapsedText => Native.DurationMs is { } duration ? CoreStrings.GoalModels_ElapsedText_2(GoalText.Number(duration)) : null;
}

// "/goal status" (Active|UserPaused with a phase and a token count) or "goal detail" (display strings from the CLI).
public sealed record GrokCurrentStatus(bool Detail, bool Active, bool Paused, string Phase, long? TokensUsed, string StatusDisplay, string? PhaseDisplay, string BudgetDisplay, string ElapsedDisplay)
{
    public string StatusTitle => Detail ? StatusDisplay : $"{(Paused ? CoreStrings.GoalModels_StatusTitle_2 : CoreStrings.GoalModels_StatusTitle_1)} · {PhaseTitle}";
    private string PhaseTitle => Phase switch { "Idle" => CoreStrings.GoalModels_PhaseTitle_1, "Planning" => CoreStrings.GoalModels_PhaseTitle_2, _ => CoreStrings.GoalModels_PhaseTitle_3 };
    public string UsageText => Detail
        ? string.Join(" · ", new[] { PhaseDisplay, BudgetDisplay, ElapsedDisplay }.OfType<string>())
        : CoreStrings.GoalModels_UsageText_8(GoalText.Number(TokensUsed ?? 0), ElapsedDisplay);
}

public sealed record GrokGoal(string Text, GrokCurrentStatus Current) : NativeGoal
{
    public override string Objective => Text;
    public override string StatusTitle => Current.StatusTitle;
    public override bool IsActive => Current.Active;
    public override bool IsPaused => Current.Paused;
    public override string UsageText => Current.UsageText;
    public override string? ElapsedText => Current.ElapsedDisplay;
}

public sealed record GoalNativeHistory(string Terminal, ClaudeGoalStatus Native)
{
    public string Title => Terminal == "cleared" ? CoreStrings.GoalModels_Title_1 : CoreStrings.GoalModels_Title_2;
}

public sealed record GoalSnapshot(string BotId, GoalAvailability Availability, GoalCapabilities Capabilities, GoalFieldCapabilities FieldCapabilities, GoalBinding? Binding,
    NativeGoal? Goal, GoalNativeHistory? NativeHistory, string? ObservedAt, string? Message, string? Reason = null)
{
    // "seat_idle": the seat is simply not running (the next message resumes it). Any other or missing reason is a read failure.
    public bool IsIdle => Availability == GoalAvailability.Unavailable && Reason == "seat_idle";
    // Mac GoalCard / GoalsView rules for which buttons exist.
    public bool CanCreate => Goal is null && Capabilities.Create && FieldCapabilities.Create.Objective;
    public bool CanEdit => Goal is not null && Capabilities.Edit && (FieldCapabilities.Edit.Objective || FieldCapabilities.Edit.TokenBudget);
    public bool CanPause => Goal?.IsActive == true && Capabilities.Pause;
    public bool CanResume => Goal?.IsPaused == true && Capabilities.Resume;
    public bool CanClear => Goal is not null && Capabilities.Clear;
    public bool HasAction => Goal is null ? CanCreate : CanEdit || CanPause || CanResume || Capabilities.Clear;
    public string StatusTitle => Goal?.StatusTitle ?? GoalPillText.None;
    // The note listing the actions the current goal does not allow; empty when there is no goal.
    public string[] UnavailableActions
    {
        get
        {
            if (Goal is not { } goal) return [];
            var names = new List<string>();
            if (!Capabilities.Edit || !(FieldCapabilities.Edit.Objective || FieldCapabilities.Edit.TokenBudget)) names.Add(CoreStrings.GoalModels_UnavailableActions_1);
            if (goal.IsActive && !Capabilities.Pause) names.Add(CoreStrings.GoalModels_StatusTitle_2);
            if (goal.IsPaused && !Capabilities.Resume) names.Add(CoreStrings.GoalModels_UnavailableActions_3);
            if (!Capabilities.Clear) names.Add(CoreStrings.GoalModels_UnavailableActions_4);
            return [.. names];
        }
    }
    public string PageFootnote => CoreStrings.GoalModels_PageFootnote_3((Capabilities.Pause || Capabilities.Resume ? CoreStrings.GoalModels_PageFootnote_1 : "") + (Capabilities.Clear ? CoreStrings.GoalModels_PageFootnote_2 : ""));
    public string UnavailableMessage => Message ?? (Availability == GoalAvailability.Unsupported ? CoreStrings.GoalModels_UnavailableMessage_1 : IsIdle ? CoreStrings.GoalModels_UnavailableMessage_2 : CoreStrings.GoalModels_UnavailableMessage_3);
    public string? HistoryText => NativeHistory is { } history ? CoreStrings.GoalModels_HistoryText_1(history.Title, history.Native.Condition) : null;
    public string? ObservedText => ObservedAt is { } at ? CoreStrings.GoalModels_ObservedText_1(GoalText.Date(at)) : null;
    // Chat pill: the elapsed text beside the status, only for an available snapshot with a goal.
    public string? PillElapsed => Availability == GoalAvailability.Available && Goal is { } goal ? goal.ElapsedText ?? CoreStrings.GoalModels_PillElapsed_1 : null;
}

public static class GoalParser
{
    private static BellApiException Bad(string detail) => new(CoreStrings.BellApi_JsonWithStatusAsync_3(detail));
    private static string Snake(string name) => string.Concat(name.Select(letter => char.IsUpper(letter) ? "_" + char.ToLowerInvariant(letter) : letter.ToString()));
    private static JsonElement? Find(JsonElement parent, string name)
    {
        if (parent.ValueKind != JsonValueKind.Object) throw Bad(CoreStrings.AppLogin_RefusedText_4(name));
        if (!parent.TryGetProperty(name, out var value) && !parent.TryGetProperty(Snake(name), out value)) return null;
        return value.ValueKind == JsonValueKind.Null ? null : value;
    }
    private static JsonElement Need(JsonElement parent, string name) => Find(parent, name) ?? throw Bad(CoreStrings.AppLogin_RefusedText_4(name));
    private static string Text(JsonElement parent, string name) => Need(parent, name) is { ValueKind: JsonValueKind.String } value ? value.GetString()! : throw Bad(CoreStrings.AppLogin_RefusedText_4(name));
    private static string? OptText(JsonElement parent, string name) => Find(parent, name) is { } value ? value.ValueKind == JsonValueKind.String ? value.GetString() : throw Bad(CoreStrings.AppLogin_RefusedText_4(name)) : null;
    private static bool Flag(JsonElement parent, string name) => Need(parent, name) is { ValueKind: JsonValueKind.True or JsonValueKind.False } value ? value.GetBoolean() : throw Bad(CoreStrings.AppLogin_RefusedText_4(name));
    private static bool? OptFlag(JsonElement parent, string name) => Find(parent, name) is { } value ? value.ValueKind is JsonValueKind.True or JsonValueKind.False ? value.GetBoolean() : throw Bad(CoreStrings.AppLogin_RefusedText_4(name)) : null;
    private static long Whole(JsonElement parent, string name) => OptWhole(parent, name) ?? throw Bad(CoreStrings.AppLogin_RefusedText_4(name));
    private static long? OptWhole(JsonElement parent, string name) => Find(parent, name) is { } value ? value.ValueKind == JsonValueKind.Number && value.TryGetInt64(out var number) ? number : throw Bad(CoreStrings.AppLogin_RefusedText_4(name)) : null;
    private static double Real(JsonElement parent, string name) => OptReal(parent, name) ?? throw Bad(CoreStrings.AppLogin_RefusedText_4(name));
    private static double? OptReal(JsonElement parent, string name) => Find(parent, name) is { } value ? value.ValueKind == JsonValueKind.Number ? value.GetDouble() : throw Bad(CoreStrings.AppLogin_RefusedText_4(name)) : null;

    public static GoalSnapshot[] ParseList(JsonElement root) => Need(root, "goals") is { ValueKind: JsonValueKind.Array } list ? [.. list.EnumerateArray().Select(ParseSnapshot)] : throw Bad(CoreStrings.GoalModels_ParseList_1);
    public static GoalSnapshot ParseDetail(JsonElement root) => ParseSnapshot(Need(root, "snapshot"));

    public static GoalSnapshot ParseSnapshot(JsonElement item)
    {
        var availability = Text(item, "availability") switch { "available" => GoalAvailability.Available, "unsupported" => GoalAvailability.Unsupported, "unavailable" => GoalAvailability.Unavailable, _ => throw Bad(CoreStrings.GoalModels_ParseSnapshot_1) };
        var capabilities = Need(item, "capabilities");
        var fields = Need(item, "fieldCapabilities");
        GoalFields Fields(string name) { var value = Need(fields, name); return new(Flag(value, "objective"), Flag(value, "tokenBudget"), Flag(value, "combined")); }
        var binding = Find(item, "binding") is { } wire ? new GoalBinding(Text(wire, "sessionId"), Text(wire, "launchId"), Text(wire, "threadId")) : null;
        var history = Find(item, "nativeHistory") is { } past ? new GoalNativeHistory(Terminal(Text(past, "terminal")), Claude(Need(past, "native"))) : null;
        if (history is not null && Text(Need(item, "nativeHistory"), "kind") != "claude-code") throw Bad(CoreStrings.GoalModels_ParseSnapshot_2);
        return new GoalSnapshot(Text(item, "botId"), availability,
            new GoalCapabilities(Flag(capabilities, "inspect"), Flag(capabilities, "create"), Flag(capabilities, "edit"), Flag(capabilities, "pause"), Flag(capabilities, "resume"), Flag(capabilities, "clear")),
            new GoalFieldCapabilities(Fields("create"), Fields("edit")), binding,
            Find(item, "goal") is { } goal ? Goal(goal) : null, history, OptText(item, "observedAt"), OptText(item, "message"), OptText(item, "reason"));
    }

    private static string Terminal(string value) => value is "cleared" or "achieved" ? value : throw Bad(CoreStrings.GoalModels_Terminal_1);
    private static ClaudeGoalStatus Claude(JsonElement native) => new(Text(native, "type"), Text(native, "condition"), Flag(native, "met"), OptFlag(native, "sentinel"), OptWhole(native, "tokens"), OptReal(native, "durationMs"), OptWhole(native, "iterations"));
    private static CodexGoal Codex(JsonElement native)
    {
        var status = Text(native, "status");
        if (status is not ("active" or "paused" or "blocked" or "usageLimited" or "budgetLimited" or "complete")) throw Bad(CoreStrings.GoalModels_Codex_1);
        return new(Text(native, "objective"), status, OptWhole(native, "tokenBudget"), Whole(native, "tokensUsed"), Real(native, "timeUsedSeconds"));
    }

    private static NativeGoal Goal(JsonElement goal)
    {
        switch (OptText(goal, "kind"))
        {
            case null: return Codex(goal);
            case "codex-cli": return Codex(Need(goal, "native"));
            case "claude-code":
                var native = Claude(Need(goal, "native"));
                if (native.Type != "goal_status" || native.Met || Text(goal, "phase") != "active") throw Bad(CoreStrings.GoalModels_Goal_1);
                return new ClaudeGoal(native, OptWhole(goal, "reportedTurns"));
            case "grok-cli":
                var current = Need(goal, "currentStatus");
                var elapsed = Text(current, "elapsedDisplay");
                if (elapsed.Length == 0) throw Bad(CoreStrings.GoalModels_Goal_2);
                var objective = Text(Need(goal, "native"), "objective");
                switch (Text(current, "source"))
                {
                    case "/goal status":
                        var status = Text(current, "status");
                        var phase = Text(current, "phase");
                        if (status is not ("Active" or "UserPaused") || phase is not ("Idle" or "Planning" or "Executing")) throw Bad(CoreStrings.GoalModels_Goal_2);
                        return new GrokGoal(objective, new(false, status == "Active", status == "UserPaused", phase, Whole(current, "tokensUsed"), "", null, "", elapsed));
                    case "goal detail":
                        var detail = Text(current, "status");
                        if (detail is not ("Active" or "Paused")) throw Bad(CoreStrings.GoalModels_Goal_2);
                        return new GrokGoal(objective, new(true, detail == "Active", detail == "Paused", OptText(current, "phase") ?? "", OptWhole(current, "tokensUsed"), Text(current, "statusDisplay"), OptText(current, "phaseDisplay"), Text(current, "budgetDisplay"), elapsed));
                    default: throw Bad(CoreStrings.GoalModels_Goal_2);
                }
            default: throw Bad(CoreStrings.GoalModels_Goal_6);
        }
    }
}

public enum GoalPillTone { Muted, Violet, Orange }
// What the goals page body shows: the list (and its empty state) only after a read that works and nothing left unconfirmed.
public enum GoalPageState { Loading, Unread, Unconfirmed, List }
// Mac ChatGoalBar (#1116, apple/goals.md 「pillの文」「未対応」「失敗表示」): whole sentences only, one failure sentence, no pill for an unsupported bot.
public static class GoalPillText
{
    public static string Checking  => CoreStrings.GoalModels_Checking_1;
    public static string None  => CoreStrings.GoalModels_None_1;
    public static string Unread  => CoreStrings.GoalModels_Unread_1;
    public static string UnreadDetail  => CoreStrings.GoalModels_UnreadDetail_1;
    // null: the bot has no goal feature, so there is no pill. An idle seat has no running goal, so it reads as none.
    public static (string Title, GoalPillTone Tone)? Pill(GoalModel goals, string botId)
    {
        if (goals.NeedsRefresh) return (Unread, GoalPillTone.Orange);
        if (!goals.Loaded) return (Checking, GoalPillTone.Muted);
        if (goals.CurrentSnapshot(botId) is not { } snapshot) return (Unread, GoalPillTone.Orange);
        if (snapshot.IsIdle) return (None, GoalPillTone.Muted);
        return snapshot.Availability switch
        {
            GoalAvailability.Unsupported => null,
            GoalAvailability.Unavailable => (Unread, GoalPillTone.Orange),
            _ => snapshot.Goal is null ? (None, GoalPillTone.Muted) : (snapshot.StatusTitle, GoalPillTone.Violet)
        };
    }
    public static GoalPageState PageState(GoalModel goals) => goals.Loading && !goals.Loaded ? GoalPageState.Loading : !goals.Loaded ? GoalPageState.Unread : goals.NeedsRefresh ? GoalPageState.Unconfirmed : GoalPageState.List;
    // The one failure sentence of the expanded card; after a change whose outcome is unknown, its own sentence replaces the generic one.
    public static string? Failure(GoalModel goals, string botId)
    {
        if (goals.NeedsRefresh) return goals.ErrorText ?? UnreadDetail;
        if (!goals.Loaded) return null;
        if (goals.CurrentSnapshot(botId) is not { } snapshot) return UnreadDetail;
        return snapshot.Availability == GoalAvailability.Unavailable && !snapshot.IsIdle ? snapshot.Message ?? UnreadDetail : null;
    }
}
