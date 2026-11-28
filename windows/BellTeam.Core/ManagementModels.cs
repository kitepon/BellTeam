using System.Text.Json.Serialization;

namespace BellTeam.Core;

public sealed record BotSettings
{
    public required string Name { get; init; }
    public string ProfileText { get; init; } = "";
    public string Personality { get; init; } = "";
    public string SpeechStyle { get; init; } = "";
    public string Position { get; init; } = "";
    public string Role { get; init; } = "";
    public string Avatar { get; init; } = "";
    public string Color { get; init; } = "violet";
    public required string Harness { get; init; }
    public string Model { get; init; } = "";
    public string ReasoningEffort { get; init; } = "";
    public bool FastMode { get; init; }
    // a366: read-only, present only while the member's stored AI is the retired Antigravity; Fields() never sends it (the server refuses an unknown field).
    public string? HarnessNotice { get; init; }
    // a311: null = this BellTeam predates the field (never sent, no switch); the Owner's HTTP PATCH is the only writer.
    public bool? ConfigurationLocked { get; init; }
    // members C1: null = this BellTeam predates the fields (never sent); "" = this BellTeam's own seat.
    public string? TerminalId { get; init; }
    public string? ProjectRoot { get; init; }
    [JsonIgnore] public BotSettings Normalized => this with { Name = Name.Trim(), Position = Position.Trim(), Model = Model.Trim(), ReasoningEffort = ReasoningEffort.Trim(), ProfileText = TextContent.Normalize(ProfileText), Personality = TextContent.Normalize(Personality), SpeechStyle = TextContent.Normalize(SpeechStyle), Role = TextContent.Normalize(Role) };
    public Dictionary<string, object?> Fields()
    {
        var fields = new Dictionary<string, object?> { ["name"] = Name, ["profileText"] = ProfileText, ["personality"] = Personality, ["speechStyle"] = SpeechStyle, ["position"] = Position, ["role"] = Role, ["avatar"] = Avatar, ["color"] = Color, ["harness"] = Harness, ["model"] = Model, ["reasoningEffort"] = ReasoningEffort, ["fastMode"] = FastMode };
        if (ConfigurationLocked is not null) fields["configurationLocked"] = ConfigurationLocked;
        if (TerminalId is not null) fields["terminalId"] = TerminalId;
        if (ProjectRoot is not null) fields["projectRoot"] = ProjectRoot;
        return fields;
    }
    public Dictionary<string, object?> ChangesFrom(BotSettings before)
    {
        var previous = before.Normalized.Fields();
        return Normalized.Fields().Where(field => !previous.TryGetValue(field.Key, out var old) || !Equals(old, field.Value)).ToDictionary(field => field.Key, field => field.Value);
    }
    public bool Matches(Dictionary<string, object?> changes) { var fields = Normalized.Fields(); return changes.All(change => fields.TryGetValue(change.Key, out var value) && Equals(value, change.Value)); }
}
public sealed record BotSettingsResponse { public required BotSettings Bot { get; init; } public bool Applying { get; init; } }
public sealed record ModelChoice
{
    public required string Id { get; init; }
    public required string[] Efforts { get; init; }
    public bool Fast { get; init; }
    [JsonPropertyName("display_name")] public string? DisplayName { get; init; }
    // The picker label (Mac ModelChoice.label): the trimmed display name, else the id. The value chosen and saved is always the id.
    [JsonIgnore] public string Label => string.IsNullOrWhiteSpace(DisplayName) ? Id : DisplayName.Trim();
}
public sealed record ApiFailure { public required string Code { get; init; } public required string Message { get; init; } }
public sealed record HarnessModels { public required ModelChoice[] Models { get; init; } public required string[] Efforts { get; init; } public string? DefaultModel { get; init; } public ApiFailure? Error { get; init; } public ApiFailure? FastUnavailable { get; init; } }
public sealed record ModelsResponse { public required Dictionary<string, HarnessModels> Models { get; init; } }
public sealed record RoomResponse { public required Room Room { get; init; } }
public sealed record RoomSettings(string Name, string Purpose, string[] MemberIds, string? RepresentativeId, string Avatar)
{
    public Dictionary<string, object?> ChangesFrom(RoomSettings before)
    {
        var changes = new Dictionary<string, object?>();
        if (Name.Trim() != before.Name.Trim()) changes["name"] = Name.Trim();
        if (TextContent.Normalize(Purpose) != TextContent.Normalize(before.Purpose)) changes["purpose"] = TextContent.Normalize(Purpose);
        if (!MemberIds.ToHashSet().SetEquals(before.MemberIds)) changes["memberIds"] = MemberIds;
        if (RepresentativeId != before.RepresentativeId) changes["representativeId"] = RepresentativeId;
        if (Avatar != before.Avatar) changes["avatar"] = Avatar;
        return changes;
    }
    public static RoomSettings From(Room room) => new(room.Name, room.Purpose, room.MemberIds, room.RepresentativeId, room.Avatar);
}

public sealed class ModelSelection(string harness, string model, string effort)
{
    public string Harness { get; private set; } = harness;
    public string Model { get; private set; } = model;
    public string Effort { get; set; } = effort;
    public Dictionary<string, HarnessModels> Catalog { get; private set; } = [];
    public void SetCatalog(Dictionary<string, HarnessModels> catalog) => Catalog = catalog;
    public void SelectHarness(string value) { Harness = value; Model = ""; Effort = ""; }
    public void SelectModel(string value) { Model = value; if (!Efforts.Contains(Effort)) Effort = ""; }
    public string[] Efforts => Catalog.TryGetValue(Harness, out var catalog) ? catalog.Models.FirstOrDefault(choice => choice.Id == (Model.Length == 0 ? catalog.DefaultModel : Model))?.Efforts ?? catalog.Efforts : [];
    // The server's FAST_MODE_UNAVAILABLE message carries the code and the CLI's English; the editor says it in one plain line.
    public static string FastUnavailableText(ApiFailure refused) => refused.Code == "FAST_MODE_UNAVAILABLE" ? CoreStrings.ManagementModels_FastUnavailableText_1 : refused.Message;
    // Mac HarnessModels.fastModeUnavailableReason: the catalog error, the account note, then the chosen (or default) model's own support.
    public string? FastUnavailableReason => !Catalog.TryGetValue(Harness, out var catalog) ? CoreStrings.ManagementModels_FastUnavailableReason_1
        : catalog.Error is not null ? catalog.Error.Message
        : catalog.FastUnavailable is { } refused ? FastUnavailableText(refused)
        : Model.Trim().Length == 0 ? (catalog.DefaultModel is { } fallback && catalog.Models.FirstOrDefault(choice => choice.Id == fallback) is { } preferred ? preferred.Fast ? null : CoreStrings.ManagementModels_FastUnavailableReason_2 : CoreStrings.ManagementModels_FastUnavailableReason_3)
        : catalog.Models.FirstOrDefault(choice => choice.Id == Model.Trim())?.Fast == false ? CoreStrings.ManagementModels_FastUnavailableReason_2
        : null;
}

// The wording of the Mac member and room editors (ManagementView.swift), kept in one place so the flows and the tests read the same text.
public static class EditorText
{
    public static string LoadingModels  => CoreStrings.ManagementModels_LoadingModels_1;
    public static string FastModeNote  => CoreStrings.ManagementModels_FastModeNote_1;
    public static string LockNote  => CoreStrings.ManagementModels_LockNote_1;
    public static string FastLoading  => CoreStrings.ManagementModels_FastLoading_1;
    public static string FastCustomEmpty  => CoreStrings.ManagementModels_FastCustomEmpty_1;
    public static string NameRequired  => CoreStrings.ManagementModels_NameRequired_1;
    public static string RoomNameRequired  => CoreStrings.ManagementModels_RoomNameRequired_1;
    public static string ImageUnreadable  => CoreStrings.ManagementModels_ImageUnreadable_1;
    public static string ImagesNeedServerUpdate  => CoreStrings.AvatarImages_UnsupportedServer_1;
    public static string SmallNoSource  => CoreStrings.ManagementModels_SmallNoSource_1;
    public static string LargeNoSource  => CoreStrings.ManagementModels_LargeNoSource_1;
    public static string MemberSaved  => CoreStrings.ManagementModels_MemberSaved_1;
    public static string SaveConfirmed  => CoreStrings.ManagementModels_SaveConfirmed_1;
    public static string SaveDifferent  => CoreStrings.ManagementModels_SaveDifferent_1;
    public static string SaveUnconfirmed(Exception error) => CoreStrings.ManagementModels_SaveUnconfirmed_1(error.Message);
    public static string Applying  => CoreStrings.ManagementModels_Applying_1;
    public static string DeletePending  => CoreStrings.ManagementModels_DeletePending_1;
    public static string DeleteUnconfirmed  => CoreStrings.ManagementModels_DeleteUnconfirmed_1;
    public static string DeleteStillListed  => CoreStrings.ManagementModels_DeleteStillListed_1;
    public static string DeleteReadFailed(Exception error) => CoreStrings.ManagementModels_DeleteReadFailed_1(error.Message);
    public static string MemberDeleteFooter  => CoreStrings.ManagementModels_MemberDeleteFooter_1;
    public static string MemberDeleteTitle(string name) => CoreStrings.ManagementModels_MemberDeleteTitle_1(name);
    public static string MemberDeleteMessage  => CoreStrings.ManagementModels_MemberDeleteMessage_1;
    public static string RoomDeleteFooter  => CoreStrings.ManagementModels_RoomDeleteFooter_1;
    public static string RoomDeleteTitle(string name) => CoreStrings.ManagementModels_MemberDeleteTitle_1(name);
    public static string RoomDeleteMessage  => CoreStrings.ManagementModels_RoomDeleteMessage_1;
    public static string RoomErrorTitle  => CoreStrings.ManagementModels_RoomErrorTitle_1;
    // Mac BellAPIError.operationFailureMessage: a failure whose outcome is unknown says so and tells the owner to look before acting again.
    public static string Failure(Exception error) => BellApiException.IsResultUnconfirmed(error) ? CoreStrings.ManagementModels_Failure_1(error.Message) : error.Message;
    // Mac RoomEditor.save: an unreadable answer and a lost connection each have their own text.
    public static string RoomSaveFailure(Exception error) => error is System.Net.Http.HttpRequestException ? CoreStrings.ManagementModels_RoomSaveFailure_1(error.Message)
        : error is BellApiException { Status: null } ? CoreStrings.ManagementModels_RoomSaveFailure_2(error.Message) : Failure(error);
}

// Mac BotSettingsRequest: the image fields a create sends, three per variant that was chosen (or reset).
public sealed record BotImageFields(AvatarVariant Variant, string Render, string Source, AvatarCropRect? Crop)
{
    public static BotImageFields From(AvatarVariant variant, AvatarSelection selection) => new(variant, selection.Render, selection.Source, selection.Crop);
    public static BotImageFields Cleared(AvatarVariant variant) => new(variant, "", "", null);
    public Dictionary<string, object?> Wire => Variant == AvatarVariant.Small
        ? new() { ["avatar"] = Render, ["avatarSource"] = Source, ["avatarCrop"] = Crop }
        : new() { ["avatarLarge"] = Render, ["avatarLargeSource"] = Source, ["avatarLargeCrop"] = Crop };
}
