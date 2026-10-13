using System.Text.Json.Serialization;

namespace BellTeam.Core;

public sealed record SessionInfo
{
    public required bool Authenticated { get; init; }
    public required string AuthMode { get; init; }
}
public sealed record Member
{
    public required string Id { get; init; }
    public string? Name { get; init; }
    public string? DisplayName { get; init; }
    public string Title => DisplayName ?? Name ?? Id;
}
public sealed record RecentMessage
{
    public required string Id { get; init; }
    public required DateTimeOffset At { get; init; }
    public string? Message { get; init; }
    public string? Kind { get; init; }
    public string? Direction { get; init; }
    public Member? Sender { get; init; }
    public string Preview => Kind == "peer" ? "他のメンバーと連絡しました" : string.IsNullOrWhiteSpace(Message) ? "画像" : Message.Replace('\n', ' ');
}
public sealed record Bot
{
    public required string Id { get; init; }
    public required string Name { get; init; }
    public required string DisplayName { get; init; }
    public string Harness { get; init; } = "";
    public string Model { get; init; } = "";
    public string ProfileText { get; init; } = "";
    public string Personality { get; init; } = "";
    public string SpeechStyle { get; init; } = "";
    public string Position { get; init; } = "";
    public string Role { get; init; } = "";
    public bool Online { get; init; }
    public RecentMessage? Recent { get; init; }
}
public sealed record Room
{
    public required string Id { get; init; }
    public required string Name { get; init; }
    public string Purpose { get; init; } = "";
    public required string[] MemberIds { get; init; }
    public RecentMessage? Recent { get; init; }
}
public sealed record TimelineMessage
{
    public required string Id { get; init; }
    public required DateTimeOffset At { get; init; }
    public string? Message { get; init; }
    public string? Kind { get; init; }
    public string? Direction { get; init; }
    public Member? Sender { get; init; }
    public string? PeerName { get; init; }
    public string? Delivery { get; init; }
    public bool? Image { get; init; }
    [JsonPropertyName("image_count")] public int? ImageCount { get; init; }
    [JsonPropertyName("image_url")] public string? ImageUrl { get; init; }
    [JsonPropertyName("image_urls")] public string[]? ImageUrls { get; init; }
    [JsonPropertyName("secret_request")] public SecretRequest? SecretRequest { get; init; }
    [JsonPropertyName("owner_question")] public OwnerQuestion? OwnerQuestion { get; init; }
    public string[] DisplayedImageUrls => ImageUrls ?? (ImageUrl is { } url ? [url] : []);
    public bool IsOutgoing => Direction == "outgoing" || Sender?.Id == "user";
}
public sealed record SecretRequest
{
    public required string Id { get; init; }
    public required string BotId { get; init; }
    public required string ToolId { get; init; }
    public required string Label { get; init; }
    public required string Message { get; init; }
    public required string Status { get; init; }
    public string? Notification { get; init; }
}
public sealed record OwnerQuestion
{
    public required string Id { get; init; }
    public required string BotId { get; init; }
    public required string Question { get; init; }
    public required string[] Options { get; init; }
    public required bool AllowOther { get; init; }
    public required string Status { get; init; }
    public string? Answer { get; init; }
}
public sealed record SecretResponse { public required SecretRequest Request { get; init; } }
public sealed record QuestionResponse { public required OwnerQuestion Question { get; init; } }
public sealed record ScreenResponse { public required bool Online { get; init; } public required string Screen { get; init; } }
public sealed record ImageAttachment(string Name, string Mime, byte[] Bytes);
public sealed record ImagePayload(string Mime, string Data);
public sealed record DraftContent(string Text, ImageAttachment[] Images, string[] Targets);
public sealed record MessagePage
{
    public required TimelineMessage[] Items { get; init; }
    [JsonPropertyName("has_more")] public required bool HasMore { get; init; }
}
public sealed record BotsResponse { public required Bot[] Bots { get; init; } }
public sealed record RoomsResponse { public required Room[] Rooms { get; init; } }
public sealed record ChatTarget(string Id, bool IsRoom)
{
    public string Path => $"/api/{(IsRoom ? "rooms" : "bots")}/{Uri.EscapeDataString(Id)}";
}
