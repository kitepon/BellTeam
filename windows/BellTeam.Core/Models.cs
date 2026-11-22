using System.Text.Json.Serialization;
using System.Text.Json;

namespace BellTeam.Core;

public sealed record SessionInfo
{
    public required bool Authenticated { get; init; }
    public required string AuthMode { get; init; }
    // a485 (app-sessions.md section 4): absent on a server that has no app sessions, which is how an app tells and keeps today's path.
    public LoginInfo? Login { get; init; }
    // Present when this request is authenticated by an app session (DELETE /api/sessions/{id} ends it).
    public string? SessionId { get; init; }
}
public sealed record LoginInfo { public bool Capability { get; init; } public bool Bound { get; init; } public bool Enforced { get; init; } }
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
    public string ReasoningEffort { get; init; } = "";
    public string ProfileText { get; init; } = "";
    public string Personality { get; init; } = "";
    public string SpeechStyle { get; init; } = "";
    public string Position { get; init; } = "";
    public string Role { get; init; } = "";
    public bool Online { get; init; }
    public bool FastMode { get; init; }
    // a311: absent on a BellTeam that predates it, which reads as false.
    public bool ConfigurationLocked { get; init; }
    // a480: when the Owner pinned this member (server pinnedAt); null/absent (an older server) is not pinned.
    public DateTimeOffset? PinnedAt { get; init; }
    public string Color { get; init; } = "violet";
    public string Avatar { get; init; } = "";
    public string AvatarVersion { get; init; } = "";
    public string? AvatarLargeVersion { get; init; }
    // Mac BotProfileImageState.usesSmallImage: no independent large image, so the large slot shows the small one.
    public bool UsesSmallImage => string.IsNullOrEmpty(AvatarLargeVersion) || AvatarLargeVersion == AvatarVersion;
    public RecentMessage? Recent { get; init; }
    public CurrentWork? CurrentWork { get; init; }
    // The seat's Claude account slot (harness-accounts contract); absent on older servers.
    public SeatAccount? Account { get; init; }
    // Both are read leniently (MemberState.cs): null, absent and a wrong type are "none" and never break the roster.
    [JsonConverter(typeof(SeatLaunchReader))] public SeatLaunch? SeatLaunch { get; init; }
    [JsonConverter(typeof(ConfigurationApplicationReader))] public ConfigurationApplication? ConfigurationApplication { get; init; }
}
// The member row's second line. Same wording as the Mac CurrentWork.label and the Web workLabel.
public sealed record CurrentWork(string? State, string? Summary, string? SummaryStatus)
{
    public static string Label(CurrentWork? work) => (work?.State, work?.SummaryStatus) switch
    {
        ("working", "current") => work!.Summary ?? "作業中・要約未設定",
        ("working", "stale") => "作業中・要約期限切れ",
        ("working", _) => "作業中・要約未設定",
        ("idle", _) => "待機中",
        _ => "仕事状況を未取得"
    };
}
public sealed record Room
{
    public required string Id { get; init; }
    public required string Name { get; init; }
    public string Purpose { get; init; } = "";
    public required string[] MemberIds { get; init; }
    public string? RepresentativeId { get; init; }
    public string Avatar { get; init; } = "";
    public string AvatarVersion { get; init; } = "";
    public RecentMessage? Recent { get; init; }
}
public sealed record TimelineMessage
{
    public required string Id { get; init; }
    public required DateTimeOffset At { get; init; }
    public string? Message { get; init; }
    // machine-stream.md "Reply, forward, quote and copy of a bubble": the text a quote, copy or forward carries; a bubble row's `message` is only its first line, so the whole machine_event.text.
    public string QuoteText => MachineEvent is { Bubble: true, Text.Length: > 0 } bubble ? bubble.Text : Message ?? "";
    public string? Kind { get; init; }
    public string? Direction { get; init; }
    public Member? Sender { get; init; }
    public string? PeerName { get; init; }
    public string? Delivery { get; init; }
    public JsonElement DeliveryTracking { get; init; }
    public JsonElement Deliveries { get; init; }
    public JsonElement Routing { get; init; }
    // A row of the read-only fork inquiry: `seat.kind == "fork"`. A seat of another type or kind is a normal row.
    [JsonConverter(typeof(MessageSeatReader))] public MessageSeat? Seat { get; init; }
    public bool IsFork => Seat?.Kind == "fork";
    // A message that came from elsewhere (conversation forward.md): a forward of another message or content shared in from another app. Absent = a normal message.
    [JsonConverter(typeof(MessageOriginReader))] public MessageOrigin? Origin { get; init; }
    // Reply to one earlier message (conversation reply.md): the snapshot saved when the reply was accepted. Absent = not a reply.
    [JsonPropertyName("reply_to"), JsonConverter(typeof(ReplyReferenceReader))] public ReplyReference? ReplyTo { get; init; }
    public bool? Image { get; init; }
    [JsonPropertyName("image_count")] public int? ImageCount { get; init; }
    [JsonPropertyName("image_url")] public string? ImageUrl { get; init; }
    [JsonPropertyName("image_urls")] public string[]? ImageUrls { get; init; }
    [JsonPropertyName("secret_request")] public SecretRequest? SecretRequest { get; init; }
    [JsonPropertyName("owner_question")] public OwnerQuestion? OwnerQuestion { get; init; }
    // A machine seat's stream-json entry (conversation machine-stream.md): `kind == "machine_event"`.
    [JsonPropertyName("machine_event")] public MachineEvent? MachineEvent { get; init; }
    public string[] DisplayedImageUrls => ImageUrls ?? (ImageUrl is { } url ? [url] : []);
    public bool IsOutgoing => Direction == "outgoing" || Sender?.Id == "user";
}
// `origin` of a history row. Message holds the Owner's comment then the content; ContentStart is where the content starts, in Unicode code points.
public sealed record MessageOrigin(string Kind, string? FromName = null, DateTimeOffset? At = null, int ContentStart = 0, string? App = null)
{
    public bool IsForward => Kind == "forward";
}
public sealed class MessageOriginReader : LenientObjectReader<MessageOrigin>
{
    // A kind other than forward / share, or a malformed value, reads as a normal message.
    protected override MessageOrigin From(JsonElement element)
    {
        var kind = Text(element, "kind");
        if (kind is not ("forward" or "share")) return new("");
        string? from = null; DateTimeOffset? at = null;
        if (element.TryGetProperty("from", out var who) && who.ValueKind == JsonValueKind.Object) from = Text(who, "name") ?? Text(who, "id");
        if (Text(element, "at") is { } stamp && DateTimeOffset.TryParse(stamp, out var parsed)) at = parsed;
        var start = element.TryGetProperty("content_start", out var offset) && offset.TryGetInt32(out var value) && value >= 0 ? value : 0;
        return new(kind, from, at, start, Text(element, "app"));
    }
}
// Which message the Owner forwards (forward.md "Request"): the conversation it is in and its id; the server copies the content.
public sealed record ForwardSource(string Kind, string Id, string MessageId);
// Content another app shared into BellTeam (forward.md "Share-in"): the sender's app name, text and URLs; shared images travel as the request's images.
public sealed record ShareContent(string? App, string? Text, string[] Urls)
{
    public const int TextLimit = 20000, UrlLimit = 20, UrlLength = 2000;
    // At least one of text, a URL or an image (the caller counts images) is needed; the server enforces the same.
    public bool HasContent(int images) => !string.IsNullOrWhiteSpace(Text) || Urls.Length != 0 || images != 0;
    // Only http(s) links are shared as URLs (the server refuses other schemes), at most 20 of at most 2000 characters.
    public static string[] WebLinks(IEnumerable<string> candidates) => candidates.Where(url => url.Length <= UrlLength && Uri.TryCreate(url, UriKind.Absolute, out var parsed) && parsed.Scheme is "http" or "https").Distinct().Take(UrlLimit).ToArray();
}
// `reply_to` of a history row. Available false: the original could not be found, so only the fixed line is drawn.
public sealed record ReplyReference(string Id, bool Available, string? SenderName = null, string Text = "", bool Truncated = false, bool Image = false, bool Part = false, int? RangeStart = null, int? RangeEnd = null)
{
    public const int TextLimit = 300;
    // The quote the client shows from the moment it picks a message, built like the server snapshot (reply.md: 300 code points, CRLF to LF).
    // A picked selection (reply.md "Quoting a selected part") replaces the text; the range is the server's to locate, so none is claimed here.
    public static ReplyReference Local(TimelineMessage original, string senderName, QuoteSelection? selection = null)
    {
        var runes = TextContent.Normalize(selection?.Text ?? original.QuoteText).EnumerateRunes().ToArray();
        return new(original.Id, true, senderName, string.Concat(runes.Take(TextLimit)), runes.Length > TextLimit, selection is null && (original.Image == true || original.DisplayedImageUrls.Length != 0), selection is not null);
    }
}
// The part of a message the Owner selected: `reply_quote` of the request. Start is the raw-text offset in code points, sent only when the client knows it.
public sealed record QuoteSelection(string Text, int? Start = null);
public sealed class ReplyReferenceReader : JsonConverter<ReplyReference?>
{
    // A malformed value reads as "not a reply" so a bad row never breaks the history.
    public override ReplyReference? Read(ref Utf8JsonReader reader, Type typeToConvert, JsonSerializerOptions options)
    {
        using var document = JsonDocument.ParseValue(ref reader);
        var e = document.RootElement;
        if (e.ValueKind != JsonValueKind.Object || !e.TryGetProperty("id", out var id) || id.ValueKind != JsonValueKind.String || id.GetString() is not { Length: > 0 } key) return null;
        static bool Flag(JsonElement o, string name) => o.TryGetProperty(name, out var v) && v.ValueKind == JsonValueKind.True;
        var part = Flag(e, "part");
        string text = e.TryGetProperty("text", out var t) && t.ValueKind == JsonValueKind.String ? t.GetString()! : "";
        // An unavailable original keeps the Owner's own excerpt when the reply was a part (nothing of the original is in it).
        if (!Flag(e, "available")) return new(key, false, null, part ? text : "", part && Flag(e, "truncated"), false, part);
        int? from = null, to = null;
        if (e.TryGetProperty("range", out var range) && range.ValueKind == JsonValueKind.Object && range.TryGetProperty("start", out var rs) && rs.TryGetInt32(out var start) && range.TryGetProperty("end", out var re) && re.TryGetInt32(out var end) && start >= 0 && end >= start) (from, to) = (start, end);
        string? sender = null;
        if (e.TryGetProperty("sender", out var s) && s.ValueKind == JsonValueKind.Object) sender = (s.TryGetProperty("name", out var n) && n.ValueKind == JsonValueKind.String ? n.GetString() : null) ?? (s.TryGetProperty("id", out var i) && i.ValueKind == JsonValueKind.String ? i.GetString() : null);
        return new(key, true, sender, text, Flag(e, "truncated"), Flag(e, "image"), part, from, to);
    }
    public override void Write(Utf8JsonWriter writer, ReplyReference? value, JsonSerializerOptions options) => throw new NotSupportedException();
}
public sealed record SecretRequest
{
    public required string Id { get; init; }
    // Null for an Owner terminal-key request (terminals #811), which has no Bot sender.
    public string? BotId { get; init; }
    // The keys route names only {id, label, inputOptions}; the rest defaults for that minimal body (as the Mac does).
    public string ToolId { get; init; } = "";
    public required string Label { get; init; }
    public string Message { get; init; } = "";
    public string Status { get; init; } = "pending";
    public string? Notification { get; init; }
    // usage secret-credentials: `terminal.ssh` | `terminal.sudo` | `terminal.login` for a terminal key; absent for a Bot request.
    public string? Purpose { get; init; }
    // Absent on an older body: the input field only.
    [JsonConverter(typeof(SecretInputOptionsReader))] public SecretInputOptions? InputOptions { get; init; }
    // usage #1025: true for a value used once and never stored; absent otherwise.
    [JsonConverter(typeof(LenientTrueReader))] public bool OneTime { get; init; }
    public bool IsLoginPassword => Purpose == "terminal.login";
    public bool IsOneTime => OneTime;
    // A value used once never offers 1Password and never says it is saved or registered.
    public bool UsedOnce => IsLoginPassword || OneTime;
    public bool OnePasswordOffered => !UsedOnce && InputOptions?.OnePasswordAvailable == true;
    public bool OpensWithOnePassword => OnePasswordOffered && InputOptions?.OpensWithOnePassword == true;
    public const string LoginPasswordText = "このMacのログインパスワード（1回だけ使い、保存しません）";
    public const string OneTimeText = "1回だけ使い、使い終わったら消します。保存せず、会話にも送られません。";
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
// `machine_event` of a history row; apps draw by View and never read the raw line. Display: show | fold | hide.
public sealed record MachineEvent
{
    public int Seq { get; init; }
    public int Part { get; init; }
    public string View { get; init; } = "unknown";
    public string Display { get; init; } = "show";
    public string? Title { get; init; }
    public string Text { get; init; } = "";
    // The row text was cut; the whole stored line is GET /api/bots/:id/machine-events/:seq.
    public bool Truncated { get; init; }
    [JsonPropertyName("shown_elsewhere")] public bool ShownElsewhere { get; init; }
    // The last words of a finished turn (machine-stream.md "Turn answer bubble"): drawn as a message bubble. Read as sent; an app never decides which words are last.
    public bool Bubble { get; init; }
    // The group of a folded entry (its view); consecutive folded entries of one group may share a line.
    [JsonPropertyName("fold_group")] public string? FoldGroup { get; init; }
    // What this entry adds to its line's count (1 on a tool_use of a tool run, 0 on the other members of the run); absent counts 1.
    [JsonPropertyName("fold_count")] public int? FoldCount { get; init; }
    public MachineTool? Tool { get; init; }
    // There is no hide: a display other than "fold" reads as show (machine-stream.md).
    public bool IsFolded => Display == "fold";
    // Never on the wire. Made by Timeline.VisibleMachine: the other rows of a run of one fold_group drawn as one line with this entry.
    [JsonIgnore] public TimelineMessage[] Folded { get; init; } = [];
    public MachineRequest? Request { get; init; }
}
public sealed record MachineTool { public string? Id { get; init; } public string? Name { get; init; } public string? Summary { get; init; } }
public sealed record MachineRequest
{
    // The history row carries request_id; the answer route returns the stored request, which names it id.
    [JsonPropertyName("request_id")] public string? RequestId { get; init; }
    public string? Id { get; init; }
    public required string Status { get; init; }
    public MachineQuestion[]? Questions { get; init; }
    public MachineAnswer[]? Answers { get; init; }
    public string? Decision { get; init; }
}
public sealed record MachineQuestion
{
    public string? Header { get; init; }
    public required string Question { get; init; }
    public bool MultiSelect { get; init; }
    public bool AllowOther { get; init; }
    public required MachineOption[] Options { get; init; }
}
public sealed record MachineOption { public required int Index { get; init; } public required string Label { get; init; } public string? Description { get; init; } }
public sealed record MachineAnswer { public int[] Indexes { get; init; } = []; public string? Other { get; init; } }
// GET /api/bots/:id/machine-events/:seq: the stored raw line, for an entry whose text was cut.
public sealed record MachineLine { public int Seq { get; init; } public string Line { get; init; } = ""; }
public sealed record SeatRequestResponse { public required MachineRequest Request { get; init; } }
public sealed record SecretResponse { public required SecretRequest Request { get; init; } }
public sealed record QuestionResponse { public required OwnerQuestion Question { get; init; } }
// Machine: a Claude seat launched in machine mode (no terminal keys); an answer without the field is a terminal seat.
public sealed record ScreenResponse { public required bool Online { get; init; } public required string Screen { get; init; } public bool Machine { get; init; } }
public sealed record ImageAttachment(string Name, string Mime, byte[] Bytes);
public sealed record ImagePayload(string Mime, string Data);
public sealed record DraftContent(string Text, ImageAttachment[] Images, string[] Targets, ReplyReference? Quote = null, QuoteSelection? Selection = null);
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
