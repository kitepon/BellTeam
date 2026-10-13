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
    [JsonIgnore] public BotSettings Normalized => this with { Name = Name.Trim(), Position = Position.Trim(), Model = Model.Trim(), ReasoningEffort = ReasoningEffort.Trim(), ProfileText = TextContent.Normalize(ProfileText), Personality = TextContent.Normalize(Personality), SpeechStyle = TextContent.Normalize(SpeechStyle), Role = TextContent.Normalize(Role) };
    public Dictionary<string, object?> Fields() => new() { ["name"] = Name, ["profileText"] = ProfileText, ["personality"] = Personality, ["speechStyle"] = SpeechStyle, ["position"] = Position, ["role"] = Role, ["avatar"] = Avatar, ["color"] = Color, ["harness"] = Harness, ["model"] = Model, ["reasoningEffort"] = ReasoningEffort, ["fastMode"] = FastMode };
    public Dictionary<string, object?> ChangesFrom(BotSettings before)
    {
        var previous = before.Normalized.Fields();
        return Normalized.Fields().Where(field => !Equals(previous[field.Key], field.Value)).ToDictionary(field => field.Key, field => field.Value);
    }
    public bool Matches(Dictionary<string, object?> changes) { var fields = Normalized.Fields(); return changes.All(change => Equals(fields[change.Key], change.Value)); }
}
public sealed record BotSettingsResponse { public required BotSettings Bot { get; init; } public bool Applying { get; init; } }
public sealed record ModelChoice { public required string Id { get; init; } public required string[] Efforts { get; init; } public bool Fast { get; init; } }
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
    public string? FastUnavailableReason => !Catalog.TryGetValue(Harness, out var catalog) ? "モデル候補を取得できていません。"
        : catalog.Error is not null ? catalog.Error.Message
        : catalog.FastUnavailable is not null ? catalog.FastUnavailable.Message
        : catalog.Models.FirstOrDefault(choice => choice.Id == (Model.Length == 0 ? catalog.DefaultModel : Model))?.Fast == true ? null
        : "選択したモデルはファストモードに対応していません。";
}
