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
    private static readonly CultureInfo Japanese = CultureInfo.GetCultureInfo("ja-JP");
    public static string Number(double value) => value.ToString("#,##0.###", Japanese);
    public static string Date(string text) => DateTimeOffset.TryParse(text, CultureInfo.InvariantCulture, DateTimeStyles.RoundtripKind, out var at) ? at.ToLocalTime().ToString("yyyy年M月d日 H:mm", Japanese) : text;
    public static string StatusTitle(string status) => status switch
    {
        "active" => "進行中", "paused" => "一時停止", "blocked" => "進行できない状態",
        "usageLimited" => "利用制限", "budgetLimited" => "予算に到達", "complete" => "完了", _ => status
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
    public override string UsageText => $"使用量 {GoalText.Number(TokensUsed)} / 予算 {(Budget is { } budget ? GoalText.Number(budget) : "指定なし")} · 作業時間 {GoalText.Number(TimeUsedSeconds)}秒";
    public override string? ElapsedText => GoalText.Number(TimeUsedSeconds) + "秒";
}

public sealed record ClaudeGoalStatus(string Type, string Condition, bool Met, bool? Sentinel, long? Tokens, double? DurationMs, long? Iterations);

public sealed record ClaudeGoal(ClaudeGoalStatus Native, long? ReportedTurns) : NativeGoal
{
    public override string Objective => Native.Condition;
    public override string StatusTitle => "進行中";
    public override bool IsActive => true;
    public override string UsageText
    {
        get
        {
            var parts = new List<string>();
            if (Native.Tokens is { } tokens) parts.Add($"使用トークン {GoalText.Number(tokens)}");
            if (Native.DurationMs is { } duration) parts.Add($"実行時間 {GoalText.Number(duration)}ミリ秒");
            if (Native.Iterations is { } iterations) parts.Add($"反復数 {GoalText.Number(iterations)}");
            if (ReportedTurns is { } turns) parts.Add($"CLI表示ターン数 {GoalText.Number(turns)}");
            return parts.Count == 0 ? "使用量・作業時間はまだ取得していません。" : string.Join(" · ", parts);
        }
    }
    public override string? ElapsedText => Native.DurationMs is { } duration ? GoalText.Number(duration) + "ミリ秒" : null;
}

// "/goal status" (Active|UserPaused with a phase and a token count) or "goal detail" (display strings from the CLI).
public sealed record GrokCurrentStatus(bool Detail, bool Active, bool Paused, string Phase, long? TokensUsed, string StatusDisplay, string? PhaseDisplay, string BudgetDisplay, string ElapsedDisplay)
{
    public string StatusTitle => Detail ? StatusDisplay : $"{(Paused ? "一時停止" : "進行中")} · {PhaseTitle}";
    private string PhaseTitle => Phase switch { "Idle" => "待機", "Planning" => "計画中", _ => "実行中" };
    public string UsageText => Detail
        ? string.Join(" · ", new[] { PhaseDisplay, BudgetDisplay, ElapsedDisplay }.OfType<string>())
        : $"使用トークン {GoalText.Number(TokensUsed ?? 0)} · 経過 {ElapsedDisplay}";
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
    public string Title => Terminal == "cleared" ? "取消" : "達成";
}

public sealed record GoalSnapshot(string BotId, GoalAvailability Availability, GoalCapabilities Capabilities, GoalFieldCapabilities FieldCapabilities, GoalBinding? Binding,
    NativeGoal? Goal, GoalNativeHistory? NativeHistory, string? ObservedAt, string? Message)
{
    // Mac GoalCard / GoalsView rules for which buttons exist.
    public bool CanCreate => Goal is null && Capabilities.Create && FieldCapabilities.Create.Objective;
    public bool CanEdit => Goal is not null && Capabilities.Edit && (FieldCapabilities.Edit.Objective || FieldCapabilities.Edit.TokenBudget);
    public bool CanPause => Goal?.IsActive == true && Capabilities.Pause;
    public bool CanResume => Goal?.IsPaused == true && Capabilities.Resume;
    public bool CanClear => Goal is not null && Capabilities.Clear;
    public bool HasAction => Goal is null ? CanCreate : CanEdit || CanPause || CanResume || Capabilities.Clear;
    public string StatusTitle => Goal?.StatusTitle ?? "ゴール未設定";
    // The note listing the actions the current goal does not allow; empty when there is no goal.
    public string[] UnavailableActions
    {
        get
        {
            if (Goal is not { } goal) return [];
            var names = new List<string>();
            if (!Capabilities.Edit || !(FieldCapabilities.Edit.Objective || FieldCapabilities.Edit.TokenBudget)) names.Add("編集");
            if (goal.IsActive && !Capabilities.Pause) names.Add("一時停止");
            if (goal.IsPaused && !Capabilities.Resume) names.Add("再開");
            if (!Capabilities.Clear) names.Add("取り消し");
            return [.. names];
        }
    }
    public string PageFootnote => (Capabilities.Pause || Capabilities.Resume ? "一時停止したゴールは再開できます。" : "") + (Capabilities.Clear ? "取り消すとゴールは消えます。" : "") + "今の処理を中断するには会話の停止ボタンを使ってください。";
    public string UnavailableMessage => Message ?? (Availability == GoalAvailability.Unsupported ? "このメンバーではゴール機能を使えません。" : "ゴールの状態を取得できません。");
    public string? HistoryText => NativeHistory is { } history ? $"前のゴール：{history.Title} · {history.Native.Condition}" : null;
    public string? ObservedText => ObservedAt is { } at ? "取得 " + GoalText.Date(at) : null;
    // Chat pill: the elapsed text beside the status, only for an available snapshot with a goal.
    public string? PillElapsed => Availability == GoalAvailability.Available && Goal is { } goal ? goal.ElapsedText ?? "時間未取得" : null;
}

public static class GoalParser
{
    private static BellApiException Bad(string detail) => new("BellTeamからの応答を読み取れませんでした。" + detail);
    private static string Snake(string name) => string.Concat(name.Select(letter => char.IsUpper(letter) ? "_" + char.ToLowerInvariant(letter) : letter.ToString()));
    private static JsonElement? Find(JsonElement parent, string name)
    {
        if (parent.ValueKind != JsonValueKind.Object) throw Bad($"（{name}）");
        if (!parent.TryGetProperty(name, out var value) && !parent.TryGetProperty(Snake(name), out value)) return null;
        return value.ValueKind == JsonValueKind.Null ? null : value;
    }
    private static JsonElement Need(JsonElement parent, string name) => Find(parent, name) ?? throw Bad($"（{name}）");
    private static string Text(JsonElement parent, string name) => Need(parent, name) is { ValueKind: JsonValueKind.String } value ? value.GetString()! : throw Bad($"（{name}）");
    private static string? OptText(JsonElement parent, string name) => Find(parent, name) is { } value ? value.ValueKind == JsonValueKind.String ? value.GetString() : throw Bad($"（{name}）") : null;
    private static bool Flag(JsonElement parent, string name) => Need(parent, name) is { ValueKind: JsonValueKind.True or JsonValueKind.False } value ? value.GetBoolean() : throw Bad($"（{name}）");
    private static bool? OptFlag(JsonElement parent, string name) => Find(parent, name) is { } value ? value.ValueKind is JsonValueKind.True or JsonValueKind.False ? value.GetBoolean() : throw Bad($"（{name}）") : null;
    private static long Whole(JsonElement parent, string name) => OptWhole(parent, name) ?? throw Bad($"（{name}）");
    private static long? OptWhole(JsonElement parent, string name) => Find(parent, name) is { } value ? value.ValueKind == JsonValueKind.Number && value.TryGetInt64(out var number) ? number : throw Bad($"（{name}）") : null;
    private static double Real(JsonElement parent, string name) => OptReal(parent, name) ?? throw Bad($"（{name}）");
    private static double? OptReal(JsonElement parent, string name) => Find(parent, name) is { } value ? value.ValueKind == JsonValueKind.Number ? value.GetDouble() : throw Bad($"（{name}）") : null;

    public static GoalSnapshot[] ParseList(JsonElement root) => Need(root, "goals") is { ValueKind: JsonValueKind.Array } list ? [.. list.EnumerateArray().Select(ParseSnapshot)] : throw Bad("（goals）");
    public static GoalSnapshot ParseDetail(JsonElement root) => ParseSnapshot(Need(root, "snapshot"));

    public static GoalSnapshot ParseSnapshot(JsonElement item)
    {
        var availability = Text(item, "availability") switch { "available" => GoalAvailability.Available, "unsupported" => GoalAvailability.Unsupported, "unavailable" => GoalAvailability.Unavailable, _ => throw Bad("（availability）") };
        var capabilities = Need(item, "capabilities");
        var fields = Need(item, "fieldCapabilities");
        GoalFields Fields(string name) { var value = Need(fields, name); return new(Flag(value, "objective"), Flag(value, "tokenBudget"), Flag(value, "combined")); }
        var binding = Find(item, "binding") is { } wire ? new GoalBinding(Text(wire, "sessionId"), Text(wire, "launchId"), Text(wire, "threadId")) : null;
        var history = Find(item, "nativeHistory") is { } past ? new GoalNativeHistory(Terminal(Text(past, "terminal")), Claude(Need(past, "native"))) : null;
        if (history is not null && Text(Need(item, "nativeHistory"), "kind") != "claude-code") throw Bad("（nativeHistory）");
        return new GoalSnapshot(Text(item, "botId"), availability,
            new GoalCapabilities(Flag(capabilities, "inspect"), Flag(capabilities, "create"), Flag(capabilities, "edit"), Flag(capabilities, "pause"), Flag(capabilities, "resume"), Flag(capabilities, "clear")),
            new GoalFieldCapabilities(Fields("create"), Fields("edit")), binding,
            Find(item, "goal") is { } goal ? Goal(goal) : null, history, OptText(item, "observedAt"), OptText(item, "message"));
    }

    private static string Terminal(string value) => value is "cleared" or "achieved" ? value : throw Bad("（terminal）");
    private static ClaudeGoalStatus Claude(JsonElement native) => new(Text(native, "type"), Text(native, "condition"), Flag(native, "met"), OptFlag(native, "sentinel"), OptWhole(native, "tokens"), OptReal(native, "durationMs"), OptWhole(native, "iterations"));
    private static CodexGoal Codex(JsonElement native)
    {
        var status = Text(native, "status");
        if (status is not ("active" or "paused" or "blocked" or "usageLimited" or "budgetLimited" or "complete")) throw Bad("（status）");
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
                if (native.Type != "goal_status" || native.Met || Text(goal, "phase") != "active") throw Bad("（claude-code）");
                return new ClaudeGoal(native, OptWhole(goal, "reportedTurns"));
            case "grok-cli":
                var current = Need(goal, "currentStatus");
                var elapsed = Text(current, "elapsedDisplay");
                if (elapsed.Length == 0) throw Bad("（currentStatus）");
                var objective = Text(Need(goal, "native"), "objective");
                switch (Text(current, "source"))
                {
                    case "/goal status":
                        var status = Text(current, "status");
                        var phase = Text(current, "phase");
                        if (status is not ("Active" or "UserPaused") || phase is not ("Idle" or "Planning" or "Executing")) throw Bad("（currentStatus）");
                        return new GrokGoal(objective, new(false, status == "Active", status == "UserPaused", phase, Whole(current, "tokensUsed"), "", null, "", elapsed));
                    case "goal detail":
                        var detail = Text(current, "status");
                        if (detail is not ("Active" or "Paused")) throw Bad("（currentStatus）");
                        return new GrokGoal(objective, new(true, detail == "Active", detail == "Paused", OptText(current, "phase") ?? "", OptWhole(current, "tokensUsed"), Text(current, "statusDisplay"), OptText(current, "phaseDisplay"), Text(current, "budgetDisplay"), elapsed));
                    default: throw Bad("（currentStatus）");
                }
            default: throw Bad("（kind）");
        }
    }
}
