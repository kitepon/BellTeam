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
        AiControlState.Enabled => CoreStrings.SettingsModels_StatusText_1,
        AiControlState.Stopping => CoreStrings.SettingsModels_StatusText_2,
        AiControlState.Stopped => CoreStrings.SettingsModels_StatusText_3,
        _ => CoreStrings.SettingsModels_StatusText_4
    };
    // Trailing text of the 全体停止 row in the category list.
    public string RowText => State switch { AiControlState.Stopped or AiControlState.Stopping => CoreStrings.SettingsModels_RowText_1, AiControlState.Unconfirmed => CoreStrings.SettingsModels_RowText_2, _ => CoreStrings.SettingsModels_RowText_3 };
    public bool Alert => State == AiControlState.Unconfirmed;
    public bool CanRefresh => State is AiControlState.Stopping or AiControlState.Unconfirmed;
    public string? UnconfirmedText => State == AiControlState.Unconfirmed && UnconfirmedBotIds.Length != 0 ? CoreStrings.SettingsModels_UnconfirmedText_1(UnconfirmedBotIds.Length) : null;
    public static Dictionary<string, object?> Body(bool paused) => new() { ["paused"] = paused };
    // The PATCH is never resent; after a failure the current value is read again and this says what happened (null: nothing to add).
    public static string? FailureNote(int? status, AiControlState after) => status switch
    {
        503 => CoreStrings.SettingsModels_FailureNote_1,
        502 => after == AiControlState.Stopped ? null : CoreStrings.SettingsModels_FailureNote_2,
        _ => CoreStrings.SettingsModels_FailureNote_3
    };
}
public sealed record AiControlResponse { public required AiControl Control { get; init; } }

public sealed record BackgroundAgentSelection(string Harness, string Model, string ReasoningEffort);
// A missing backgroundAgent key means the server has no such setting; revision/selection null means "not configured yet".
// Notice (a366) is GET /api/settings backgroundAgentNotice: set only while the stored selection is the retired Antigravity; it is never sent back.
public sealed record BackgroundAgentRecord(string? Revision, BackgroundAgentSelection? Selection, string? Notice = null)
{
    public static string Describe(BackgroundAgentSelection selection) => string.Join(" · ", selection.Harness, selection.Model, selection.ReasoningEffort.Length == 0 ? CoreStrings.AvatarImages_DefaultValue_1 : selection.ReasoningEffort);
    public string Summary => Selection is null ? CoreStrings.PlanningModels_StatusText_4 : Describe(Selection);
    // The first save must send expectedRevision: null explicitly; omitting the key is rejected by the server.
    public Dictionary<string, object?> UpdateBody(BackgroundAgentSelection draft) => new() { ["expectedRevision"] = Revision, ["harness"] = draft.Harness, ["model"] = draft.Model, ["reasoningEffort"] = draft.ReasoningEffort };
    public static BackgroundAgentRecord? Read(JsonElement settings)
    {
        if (!settings.TryGetProperty("backgroundAgent", out var value)) return null;
        var record = value.Deserialize<BackgroundAgentRecord>(BellApi.Json) ?? throw new BellApiException(CoreStrings.SettingsModels_Read_1);
        return settings.TryGetProperty("backgroundAgentNotice", out var notice) && notice.ValueKind == JsonValueKind.String ? record with { Notice = notice.GetString() } : record;
    }
}
public sealed record BackgroundAgentResponse { public required BackgroundAgentRecord BackgroundAgent { get; init; } }

public static class BackgroundAgentChoices
{
    public static readonly (string Id, string Label)[] Harnesses = [("codex", "Codex"), ("claude", "Claude"), ("grok", "Grok"), ("cursor", "Cursor")];
    public static ModelChoice[] Models(Dictionary<string, HarnessModels> catalog, string harness) => catalog.TryGetValue(harness, out var listed) ? listed.Models : [];
    public static string[] Efforts(Dictionary<string, HarnessModels> catalog, string harness, string model) => Models(catalog, harness).FirstOrDefault(choice => choice.Id == model)?.Efforts ?? [];
    // Decides saveability from the model catalog alone; a value missing from the catalog is never replaced by another.
    public static string? Problem(Dictionary<string, HarnessModels> catalog, BackgroundAgentSelection selection)
    {
        if (selection.Harness.Length == 0) return CoreStrings.SettingsModels_Problem_1;
        if (!catalog.TryGetValue(selection.Harness, out var listed)) return CoreStrings.ManagementModels_FastUnavailableReason_1;
        if (listed.Error is { } error) return error.Message;
        if (selection.Model.Length == 0) return CoreStrings.SettingsModels_Problem_3;
        var choice = listed.Models.FirstOrDefault(item => item.Id == selection.Model);
        if (choice is null) return CoreStrings.SettingsModels_Problem_4;
        if (choice.Efforts.Length == 0) return selection.ReasoningEffort.Length == 0 ? null : CoreStrings.SettingsModels_Problem_5;
        return choice.Efforts.Contains(selection.ReasoningEffort) ? null : CoreStrings.SettingsModels_Problem_6;
    }
}

// How a conversation's message cards enter when it is opened (Mac ConversationOpening).
[JsonConverter(typeof(JsonStringEnumConverter<ConversationOpening>))]
public enum ConversationOpening { [JsonStringEnumMemberName("rise")] Rise, [JsonStringEnumMemberName("fade")] Fade }

public enum HarnessTone { Muted, Good, Warning }
// State text and action label of one AI-authentication row in the AI settings card (Mac HarnessAuthenticationRow).
public sealed record HarnessRowState(string Title, HarnessTone Tone, string Action)
{
    public static readonly HarnessRowState Checking = new(CoreStrings.SettingsModels_Checking_1, HarnessTone.Muted, CoreStrings.SettingsModels_Checking_2);
    public static readonly HarnessRowState Unavailable = new(CoreStrings.SettingsModels_RowText_2, HarnessTone.Warning, CoreStrings.SettingsModels_Checking_2);
    // An unreadable status is shown as unavailable, never as 未認証.
    public static HarnessRowState From(string? status, bool? reloginSupported) => status switch
    {
        "authenticated" => new(CoreStrings.SettingsModels_From_1, HarnessTone.Good, reloginSupported == false ? CoreStrings.SettingsModels_From_2 : CoreStrings.SettingsModels_From_3),
        "blocked" => new(CoreStrings.SettingsModels_From_4, HarnessTone.Warning, CoreStrings.SettingsModels_From_5),
        "waiting" => new(CoreStrings.SettingsModels_From_6, HarnessTone.Muted, CoreStrings.SettingsModels_From_7),
        _ => Unavailable
    };
    // One Claude account slot (「1stアカウント」/「2ndアカウント」): the same badge and button wording as the other AI rows (Mac f37b05a4).
    // a451: an AI that cannot run shows the install state in the row and the install button as its action.
    public static HarnessRowState FromInstall(HarnessCliInstall install) => install.State switch
    {
        "not_installed" => new(CoreStrings.SettingsModels_FromInstall_1, HarnessTone.Warning, install.ButtonLabel),
        "installing" => new(CoreStrings.SettingsModels_FromInstall_2, HarnessTone.Muted, install.ButtonLabel),
        "failed" => new(CoreStrings.SettingsModels_FromInstall_3, HarnessTone.Warning, install.ButtonLabel),
        _ => Checking
    };
    public static HarnessRowState FromSlot(string? status) => From(status, reloginSupported: null);
}
