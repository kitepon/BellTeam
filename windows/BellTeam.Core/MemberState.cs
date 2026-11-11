using System.Text.Json;
using System.Text.Json.Serialization;

namespace BellTeam.Core;

// Status values the roster and the history carry beside the member: a field of the wrong type reads as absent and a value that is not an object
// reads as no value, so a malformed notice never breaks the member list or the history (Mac `try?` decoding of the same fields).
public abstract class LenientObjectReader<T> : JsonConverter<T?> where T : class
{
    protected abstract T From(JsonElement element);
    public override T? Read(ref Utf8JsonReader reader, Type typeToConvert, JsonSerializerOptions options)
    {
        using var document = JsonDocument.ParseValue(ref reader);
        return document.RootElement.ValueKind == JsonValueKind.Object ? From(document.RootElement) : null;
    }
    public override void Write(Utf8JsonWriter writer, T? value, JsonSerializerOptions options) => throw new NotSupportedException();
    protected static string? Text(JsonElement element, string name) => element.TryGetProperty(name, out var value) && value.ValueKind == JsonValueKind.String ? value.GetString() : null;
}

// Bot item `seatLaunch` (execution remote-seat.md "Launch notice"): why a terminal member did not start.
public sealed record SeatLaunch(string? Code, string? Action)
{
    // The one plain line (same as Web and the Mac SeatLaunch.line): the action, or the code when the action is blank.
    public string Line => new[] { Action, Code }.Select(text => text?.Trim()).FirstOrDefault(text => !string.IsNullOrEmpty(text)) is { } reason ? "端末で起動できません：" + reason : "端末で起動できません。";
}
public sealed class SeatLaunchReader : LenientObjectReader<SeatLaunch> { protected override SeatLaunch From(JsonElement element) => new(Text(element, "code"), Text(element, "action")); }

// Bot item `configurationApplication` (execution configuration-requests.md "Application view"): what happened to the last settings change of a running member.
public sealed record ConfigurationApplication(string? State, string? Message)
{
    // The member editor's status line, worded as the Web renderBotConfigurationStatus and the Mac ConfigurationApplication.line.
    // Null for a new member (no bot) and for a failed record without a message.
    public static string? Line(Bot? bot)
    {
        if (bot is null) return null;
        var record = bot.ConfigurationApplication;
        return record?.State switch
        {
            "pending" => "現在の作業が終わった後に設定を反映します。適用はまだ確認できていません。",
            "failed" => string.IsNullOrEmpty(record.Message) ? null : record.Message,
            "accepted" => "CLIが設定変更を受け付けました。",
            _ => bot.Online ? "保存した希望設定です。稼働中のCLIへの適用は未確認です。" : "次回の起動に使う希望設定です。"
        };
    }
    // The state that picks the icon and colour: only the three recorded states; anything else is a plain line.
    public static string? Marked(Bot? bot) => bot?.ConfigurationApplication?.State is { } state && (state is "pending" or "accepted" or "failed") ? state : null;
}
public sealed class ConfigurationApplicationReader : LenientObjectReader<ConfigurationApplication> { protected override ConfigurationApplication From(JsonElement element) => new(Text(element, "state"), Text(element, "message")); }

// History row `seat` (conversation fork-inquiry.md "Records and display"): only `kind` is read.
public sealed record MessageSeat(string? Kind);
public sealed class MessageSeatReader : LenientObjectReader<MessageSeat> { protected override MessageSeat From(JsonElement element) => new(Text(element, "kind")); }
