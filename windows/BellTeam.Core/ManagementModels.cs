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
    // members C1: null = this BellTeam predates the fields (never sent); "" = this BellTeam's own seat.
    public string? TerminalId { get; init; }
    public string? ProjectRoot { get; init; }
    [JsonIgnore] public BotSettings Normalized => this with { Name = Name.Trim(), Position = Position.Trim(), Model = Model.Trim(), ReasoningEffort = ReasoningEffort.Trim(), ProfileText = TextContent.Normalize(ProfileText), Personality = TextContent.Normalize(Personality), SpeechStyle = TextContent.Normalize(SpeechStyle), Role = TextContent.Normalize(Role) };
    public Dictionary<string, object?> Fields()
    {
        var fields = new Dictionary<string, object?> { ["name"] = Name, ["profileText"] = ProfileText, ["personality"] = Personality, ["speechStyle"] = SpeechStyle, ["position"] = Position, ["role"] = Role, ["avatar"] = Avatar, ["color"] = Color, ["harness"] = Harness, ["model"] = Model, ["reasoningEffort"] = ReasoningEffort, ["fastMode"] = FastMode };
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
    public static string FastUnavailableText(ApiFailure refused) => refused.Code == "FAST_MODE_UNAVAILABLE" ? "このアカウントではファストモードを使えません。" : refused.Message;
    // Mac HarnessModels.fastModeUnavailableReason: the catalog error, the account note, then the chosen (or default) model's own support.
    public string? FastUnavailableReason => !Catalog.TryGetValue(Harness, out var catalog) ? "モデル候補を読み込めませんでした。"
        : catalog.Error is not null ? catalog.Error.Message
        : catalog.FastUnavailable is { } refused ? FastUnavailableText(refused)
        : Model.Trim().Length == 0 ? (catalog.DefaultModel is { } fallback && catalog.Models.FirstOrDefault(choice => choice.Id == fallback) is { } preferred ? preferred.Fast ? null : "このモデルはファストモードに対応していません。" : "既定モデルの対応を確認できません。")
        : catalog.Models.FirstOrDefault(choice => choice.Id == Model.Trim())?.Fast == false ? "このモデルはファストモードに対応していません。"
        : null;
}

// The wording of the Mac member and room editors (ManagementView.swift), kept in one place so the flows and the tests read the same text.
public static class EditorText
{
    public const string LoadingModels = "使えるモデルを確かめています…";
    public const string FastModeNote = "オンにすると利用枠を多く使います。";
    public const string FastLoading = "モデル候補を読み込んでいます。";
    public const string FastCustomEmpty = "モデルIDを入力してください。";
    public const string NameRequired = "名前を入力してください。";
    public const string RoomNameRequired = "ルーム名を入力してください。";
    public const string ImageUnreadable = "画像を読み込めませんでした。";
    public const string ImagesNeedServerUpdate = "画像の独立編集はサーバー更新後に利用できます。";
    public const string SmallNoSource = "元画像が残っていないため、現在の切り抜きの外側は再調整できません。";
    public const string LargeNoSource = "大画像の元画像が残っていないため、現在の切り抜きの外側は再調整できません。";
    public const string MemberSaved = "メンバーの内容は保存しました。";
    public const string SaveConfirmed = "保存した内容をサーバーで確認しました。";
    public const string SaveDifferent = "サーバーの保存内容は入力と一致していません。入力は残しています。";
    public static string SaveUnconfirmed(Exception error) => "保存結果を確認できませんでした。入力は残しています。\n" + error.Message;
    public const string Applying = "設定を保存しました。現在の作業が終わってから適用します。";
    public const string DeletePending = "削除を受け付けました。メンバーが一覧から消えるまで、削除完了は確認できません。";
    public const string DeleteUnconfirmed = "削除要求の結果を確認できませんでした。再操作する前に一覧を確認してください。";
    public const string DeleteStillListed = "メンバーはまだ一覧にあります。削除完了は確認できません。";
    public static string DeleteReadFailed(Exception error) => "削除結果を確認できませんでした。\n" + error.Message;
    public const string MemberDeleteFooter = "このメンバーの会話・予定・記憶を含むプロジェクトを削除し、ルームから外します。元に戻せません。";
    public static string MemberDeleteTitle(string name) => $"「{name}」を削除しますか？";
    public const string MemberDeleteMessage = "AIセッションを停止し、このメンバーの設定・会話・予定・記憶を含むプロジェクトを削除します。ルームからも外れ、元に戻せません。";
    public const string RoomDeleteFooter = "このルームの設定・会話履歴・予定を削除します。参加メンバーは削除されません。";
    public static string RoomDeleteTitle(string name) => $"「{name}」を削除しますか？";
    public const string RoomDeleteMessage = "このルームの設定・会話履歴・予定が削除され、元に戻せません。参加メンバーと個別の記憶は残ります。";
    public const string RoomErrorTitle = "操作を完了できませんでした";
    // Mac BellAPIError.operationFailureMessage: a failure whose outcome is unknown says so and tells the owner to look before acting again.
    public static string Failure(Exception error) => BellApiException.IsResultUnconfirmed(error) ? "操作の結果を確認できませんでした。再操作する前に、現在の状態を更新して確認してください。\n" + error.Message : error.Message;
    // Mac RoomEditor.save: an unreadable answer and a lost connection each have their own text.
    public static string RoomSaveFailure(Exception error) => error is System.Net.Http.HttpRequestException ? "接続が切れ、保存結果を確認できませんでした。やり直す前にルーム一覧を確認してください。\n" + error.Message
        : error is BellApiException { Status: null } ? "保存結果を確認できませんでした。やり直す前にルーム一覧を確認してください。\n" + error.Message : Failure(error);
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
