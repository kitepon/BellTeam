using System.Text.Json;
using System.Text.Json.Serialization;

namespace BellTeam.Core;

[JsonConverter(typeof(JsonStringEnumConverter<AiControlState>))]
public enum AiControlState { [JsonStringEnumMemberName("enabled")] Enabled, [JsonStringEnumMemberName("stopping")] Stopping, [JsonStringEnumMemberName("stopped")] Stopped, [JsonStringEnumMemberName("unconfirmed")] Unconfirmed }
// GET/PATCH /api/ai-control. Wording follows the Mac StopSettingsPage.
public sealed record AiControl
{
    public bool Paused { get; init; }
    public AiControlState State { get; init; }
    public string[] UnconfirmedBotIds { get; init; } = [];
    public string StatusText => State switch
    {
        AiControlState.Enabled => "いまは全員が動ける状態です。",
        AiControlState.Stopping => "全員へ停止の指示を送っています。",
        AiControlState.Stopped => "全員へ停止の指示を送りました。OFFにすると、また依頼を受け付けます。",
        _ => "止まったか確かめられませんでした。全体停止はONのままです。"
    };
    // Trailing text of the 全体停止 row in the category list.
    public string RowText => State switch { AiControlState.Stopped or AiControlState.Stopping => "停止中", AiControlState.Unconfirmed => "確認できません", _ => "動作中" };
    public bool Alert => State == AiControlState.Unconfirmed;
    public bool CanRefresh => State is AiControlState.Stopping or AiControlState.Unconfirmed;
    public string? UnconfirmedText => State == AiControlState.Unconfirmed && UnconfirmedBotIds.Length != 0 ? $"止まったことを確かめられなかったメンバー: {UnconfirmedBotIds.Length}人" : null;
    public static Dictionary<string, object?> Body(bool paused) => new() { ["paused"] = paused };
    // The PATCH is never resent; after a failure the current value is read again and this says what happened (null: nothing to add).
    public static string? FailureNote(int? status, AiControlState after) => status switch
    {
        503 => "変更を保存できませんでした。現在の状態を表示しています。",
        502 => after == AiControlState.Stopped ? null : "停止操作の結果を確認できませんでした。現在の状態を表示しています。",
        _ => "通信後の現在の状態を読み直しました。"
    };
}
public sealed record AiControlResponse { public required AiControl Control { get; init; } }

public sealed record BackgroundAgentSelection(string Harness, string Model, string ReasoningEffort);
// A missing backgroundAgent key means the server has no such setting; revision/selection null means "not configured yet".
public sealed record BackgroundAgentRecord(string? Revision, BackgroundAgentSelection? Selection)
{
    public static string Describe(BackgroundAgentSelection selection) => string.Join(" · ", selection.Harness, selection.Model, selection.ReasoningEffort.Length == 0 ? "CLIの既定" : selection.ReasoningEffort);
    public string Summary => Selection is null ? "未設定" : Describe(Selection);
    // The first save must send expectedRevision: null explicitly; omitting the key is rejected by the server.
    public Dictionary<string, object?> UpdateBody(BackgroundAgentSelection draft) => new() { ["expectedRevision"] = Revision, ["harness"] = draft.Harness, ["model"] = draft.Model, ["reasoningEffort"] = draft.ReasoningEffort };
    public static BackgroundAgentRecord? Read(JsonElement settings)
    {
        if (!settings.TryGetProperty("backgroundAgent", out var value)) return null;
        return value.Deserialize<BackgroundAgentRecord>(BellApi.Json) ?? throw new BellApiException("要約のAIの設定を読み取れませんでした。");
    }
}
public sealed record BackgroundAgentResponse { public required BackgroundAgentRecord BackgroundAgent { get; init; } }

public static class BackgroundAgentChoices
{
    public static readonly (string Id, string Label)[] Harnesses = [("codex", "Codex"), ("claude", "Claude"), ("grok", "Grok"), ("cursor", "Cursor"), ("antigravity", "Antigravity")];
    public static ModelChoice[] Models(Dictionary<string, HarnessModels> catalog, string harness) => catalog.TryGetValue(harness, out var listed) ? listed.Models : [];
    public static string[] Efforts(Dictionary<string, HarnessModels> catalog, string harness, string model) => Models(catalog, harness).FirstOrDefault(choice => choice.Id == model)?.Efforts ?? [];
    // Decides saveability from the model catalog alone; a value missing from the catalog is never replaced by another.
    public static string? Problem(Dictionary<string, HarnessModels> catalog, BackgroundAgentSelection selection)
    {
        if (!catalog.TryGetValue(selection.Harness, out var listed)) return "モデル候補を読み込めませんでした。";
        if (listed.Error is { } error) return error.Message;
        if (selection.Model.Length == 0) return "モデルを選んでください。";
        var choice = listed.Models.FirstOrDefault(item => item.Id == selection.Model);
        if (choice is null) return "保存されているモデルは現在の候補にありません。選び直してください。";
        if (choice.Efforts.Length == 0) return selection.ReasoningEffort.Length == 0 ? null : "このモデルはエフォートを指定できません。";
        return choice.Efforts.Contains(selection.ReasoningEffort) ? null : "このモデルで使えるエフォートを選んでください。";
    }
}

// How a conversation's message cards enter when it is opened (Mac ConversationOpening).
[JsonConverter(typeof(JsonStringEnumConverter<ConversationOpening>))]
public enum ConversationOpening { [JsonStringEnumMemberName("rise")] Rise, [JsonStringEnumMemberName("fade")] Fade }

public enum HarnessTone { Muted, Good, Warning }
// State text and action label of one AI-authentication row in the AI settings card (Mac HarnessAuthenticationRow).
public sealed record HarnessRowState(string Title, HarnessTone Tone, string Action)
{
    public static readonly HarnessRowState Checking = new("確認中", HarnessTone.Muted, "確認する");
    public static readonly HarnessRowState Unavailable = new("確認できません", HarnessTone.Warning, "確認する");
    // An unreadable status is shown as unavailable, never as 未認証.
    public static HarnessRowState From(string? status, bool? reloginSupported) => status switch
    {
        "authenticated" => new("認証済み", HarnessTone.Good, reloginSupported == false ? "詳しく見る" : "認証し直す"),
        "blocked" => new("未認証", HarnessTone.Warning, "認証する"),
        "waiting" => new("認証中", HarnessTone.Muted, "続ける"),
        _ => Unavailable
    };
    // One Claude account slot (「1stアカウント」/「2ndアカウント」): the same badge and button wording as the other AI rows (Mac f37b05a4).
    public static HarnessRowState FromSlot(string? status) => From(status, reloginSupported: null);
}
