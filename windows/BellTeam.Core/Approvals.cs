using System.Globalization;
using System.Text.Json;

namespace BellTeam.Core;

// 決裁箱 (Approval Box extension) data: /api/approvals/* contract v0.1 (docs/architecture/modules/approval-box-extension/contract/approvals-contract.md).
// Additive-only: every field is optional and unknown fields are ignored. Ids exist only here, never on screen.
public sealed record ApprovalSummary
{
    public string? Schema { get; init; }
    public int Pending { get; init; }
    public int Urgent { get; init; }
    public int Held { get; init; }
    public int AnsweredToday { get; init; }
    public int FiledToday { get; init; }
    public ApprovalByOrigin? ByOrigin { get; init; }
}
public sealed record ApprovalByOrigin { public int Bellteam { get; init; } public int External { get; init; } }
public sealed record ApprovalOption { public string? Id { get; init; } public string? Label { get; init; } public bool Recommended { get; init; } }
public sealed record ApprovalAttachment { public string? Id { get; init; } public string? Name { get; init; } public string? ContentType { get; init; } public long Size { get; init; } public string? Sha256 { get; init; } }
public sealed record ApprovalAnswer { public string? OptionId { get; init; } public string? Text { get; init; } public ApprovalAttachment[]? Attachments { get; init; } public string? AnsweredAt { get; init; } }
public sealed record ApprovalAmended { public bool Is { get; init; } public string[]? Fields { get; init; } public string? Note { get; init; } public string? At { get; init; } }
public sealed record ApprovalHistoryItem { public string? At { get; init; } public string? Kind { get; init; } public string? By { get; init; } public string? Note { get; init; } public string[]? Fields { get; init; } }
public sealed record ApprovalOrigin
{
    public string? Kind { get; init; } public string? Basis { get; init; } public string? Client { get; init; } public string? Tool { get; init; }
    public string? SessionLabel { get; init; } public string? WorkLabel { get; init; } public string? ConnectionLabel { get; init; } public string? Via { get; init; }
}
public sealed record ApprovalRequester { public string? BotId { get; init; } public string? Name { get; init; } }
public sealed record ApprovalChart { public string? Name { get; init; } public string? ProjectId { get; init; } }
public sealed record ApprovalTask { public string? Title { get; init; } public string? State { get; init; } public string? Lane { get; init; } public string? CardId { get; init; } }
public sealed record ApprovalLink
{
    public string? State { get; init; } public bool Attached { get; init; } public ApprovalChart? Chart { get; init; } public ApprovalTask? Task { get; init; }
    public ApprovalTask[]? Previous { get; init; } public ApprovalTask[]? Next { get; init; }
}
public sealed record ViewDecision
{
    public string? Id { get; init; } public string? Title { get; init; } public string? Context { get; init; }
    public ApprovalOption[]? Options { get; init; } public string? Urgency { get; init; } public string? Deadline { get; init; } public string? Status { get; init; }
    public ApprovalAnswer? Answer { get; init; } public string? Delivery { get; init; } public string? ResumePhrase { get; init; } public long Version { get; init; }
    public string? CreatedAt { get; init; } public string? UpdatedAt { get; init; } public string? CancelReason { get; init; }
    public ApprovalAmended? Amended { get; init; } public ApprovalHistoryItem[]? History { get; init; } public ApprovalAttachment[]? RequestAttachments { get; init; }
    public ApprovalOrigin? Origin { get; init; } public ApprovalRequester? Requester { get; init; } public ApprovalLink? Link { get; init; }
    // The by-decision lookup answered 404 (read, and not linked); Link null without it means the lookup has not answered yet.
    public bool NotLinked { get; init; }
}
/// <summary>GET /api/approvals/connection: connected | waiting | denied | not_connected | expired.</summary>
public sealed record ApprovalConnection { public string? State { get; init; } public string? ConnectedAt { get; init; } public string? ExpiresAt { get; init; } }
public sealed record ApprovalConnectStart { public string? AuthorizationUrl { get; init; } public string? ExpiresAt { get; init; } }

/// <summary>What the apps draw when a call fails (screen-spec failure views), decided from the HTTP answer alone.</summary>
public enum ApprovalFailure { Old, NotEntitled, Expired, NoCredential, Conflict, Wait, Reconnect, Gone, Refused }

public sealed record ApprovalBadge(string Text, string Tone, string Glyph);
public sealed record ApprovalNote(string Text, string Tone);
public sealed record ApprovalOriginView(ApprovalRequester? Member, bool Unknown, bool External, string Tile, string Tool, string Session, string Via, string Name, string Who);
public sealed record ApprovalCardRow(string Id, string Status, string Title, IReadOnlyList<ApprovalBadge> Badges, ApprovalNote Note, IReadOnlyList<string> Chips, ApprovalOriginView Origin, bool Urgent, string Age, string Label);
public sealed record ApprovalDoneRow(string Id, string Title, bool Cancelled, ApprovalOriginView Origin, string Line, string Time, ApprovalBadge? Delivery);
public sealed record ApprovalDoneGroup(string Heading, IReadOnlyList<ApprovalDoneRow> Rows);
public sealed record ApprovalDeliveryNote(string Tone, string Text, bool Copy);
public sealed record ApprovalHistoryRow(string Time, string Kind, string Text, bool Amended);
public sealed record ApprovalLinkIds(string ProjectId, string CardId);
public sealed record ApprovalLinkPanel(string Kind, string Title, IReadOnlyList<string> Lines, IReadOnlyList<ApprovalTask> Previous, ApprovalTask? Task, IReadOnlyList<ApprovalTask> Next, string Chart, string Sentence, ApprovalLinkIds? Ids);
public sealed record ApprovalCounts(int Pending, int Urgent, int Held, int Answered, int Filed, double Fraction);
public sealed record ApprovalOriginCounts(int All, int Bellteam, int External);
public sealed record ApprovalEntryView(int Pending, bool Urgent, string Sub, string Label);

/// <summary>Port of web/approvals-model.js (Admi): the words and decisions of the 決裁箱 screen with no drawing in them.</summary>
public static class Approvals
{
    public const string SummarySchema = "bellteam.approvals-summary.v1";
    public static string NotAvailable  => CoreStrings.Approvals_NotAvailable_1;
    public static string Loading  => CoreStrings.Approvals_Loading_1;
    public static string Reconnect  => CoreStrings.Approvals_Reconnect_1;
    public static string EmptyPending  => CoreStrings.Approvals_EmptyPending_1;
    public static string EmptyHeld  => CoreStrings.Approvals_EmptyHeld_1;
    public static string EmptyDone  => CoreStrings.Approvals_EmptyDone_1;
    public static string Retry  => CoreStrings.Approvals_Retry_1;
    public static string HoldFailed  => CoreStrings.Approvals_HoldFailed_1;
    public static string Waiting  => CoreStrings.Approvals_Waiting_1;
    public static string Denied  => CoreStrings.Approvals_Denied_1;
    public static string ConnectFailed  => CoreStrings.Approvals_ConnectFailed_1;
    // The Approval Box device states (design peer-channel-signin.md section 3, Delta: the Japanese copy is the contract).
    public static string DeviceSignedOut  => CoreStrings.Approvals_DeviceSignedOut_1;
        public static string DevicePassEnded  => CoreStrings.Approvals_DevicePassEnded_1;
        public static string DeviceAccountDeleted  => CoreStrings.Approvals_DeviceAccountDeleted_1;
        public static string DeviceRemoved  => CoreStrings.Approvals_DeviceRemoved_1;
        public static string DeviceJoining  => CoreStrings.Approvals_DeviceJoining_1;
        public static string DeviceNeedsApproval  => CoreStrings.Approvals_DeviceNeedsApproval_1;
        public static string DeviceNotEntitled  => CoreStrings.Approvals_DeviceNotEntitled_1;
        public static string DeviceUpdateNeeded  => CoreStrings.Approvals_DeviceUpdateNeeded_1;
        public static string DeviceUnknown  => CoreStrings.Approvals_DeviceUnknown_1;
    public static string DeviceAskApproval  => CoreStrings.Approvals_DeviceAskApproval_1;
    public static string DeviceApprovalHow  => CoreStrings.Approvals_DeviceApprovalHow_1;
    public static string DeviceApprovalExpired  => CoreStrings.Approvals_DeviceApprovalExpired_1;
    public static string DeviceApprovalFailed  => CoreStrings.Approvals_DeviceApprovalFailed_1;
    public static string DeviceApprovalLeft(TimeSpan left) => left.TotalMinutes >= 1 ? CoreStrings.Approvals_DeviceApprovalLeft_1((int)Math.Ceiling(left.TotalMinutes)) : CoreStrings.Approvals_DeviceApprovalLeft_2;
    public static string DeviceSigningIn  => CoreStrings.Approvals_DeviceSigningIn_1;
    public static string DeviceHandoffHow  => CoreStrings.Approvals_DeviceHandoffHow_1;
    public static string DeviceHandoffStart  => CoreStrings.Approvals_DeviceHandoffStart_1;
    // Delta (a490j review): never the runtime's own reason (an exception text); one fixed line.
    public static string DeviceReconnecting  => CoreStrings.Approvals_DeviceReconnecting_1;
    public static string AmendedPlain  => CoreStrings.Approvals_AmendedPlain_1;   // client-v0.5.md section 7: a 409 on an answer
    public static string Amended(string name) => CoreStrings.Approvals_Amended_1(name);

    // ---- failure: HTTP answer -> kind of view
    public static ApprovalFailure FailureOf(int status, JsonElement? body)
    {
        var error = ErrorOf(body); var code = Str(error, "code");
        if (status == 404) return code == "not_found" ? ApprovalFailure.Gone : ApprovalFailure.Old;
        if (status == 402) return ApprovalFailure.Expired;
        if (status == 403 && code == "not_entitled") return Str(error, "state") is "expired" or "revoked" ? ApprovalFailure.Expired : ApprovalFailure.NotEntitled;
        if (status == 409) return code == "not_connected" ? ApprovalFailure.NoCredential : code == "conflict" && Obj(error, "decision") is not null ? ApprovalFailure.Conflict : ApprovalFailure.Refused;
        if (status == 429) return ApprovalFailure.Wait;
        return status is <= 0 or >= 500 ? ApprovalFailure.Reconnect : ApprovalFailure.Refused;
    }
    private static JsonElement? ErrorOf(JsonElement? body) => body is { ValueKind: JsonValueKind.Object } root && root.TryGetProperty("error", out var error) && error.ValueKind == JsonValueKind.Object ? error : null;
    private static string? Str(JsonElement? element, string name) => element is { ValueKind: JsonValueKind.Object } e && e.TryGetProperty(name, out var value) && value.ValueKind == JsonValueKind.String ? value.GetString() : null;
    private static JsonElement? Obj(JsonElement? element, string name) => element is { ValueKind: JsonValueKind.Object } e && e.TryGetProperty(name, out var value) && value.ValueKind == JsonValueKind.Object ? value : null;
    /// <summary>The 1, 2, 4 … 30 s reconnect schedule (each +-20% jitter), never giving up.</summary>
    public static int BackoffMs(int attempt, Func<double>? random = null)
        => Math.Min(30000, (int)Math.Round(Math.Min(30000, 1000 * Math.Pow(2, Math.Max(0, attempt))) * (0.8 + 0.4 * (random ?? Random.Shared.NextDouble)()), MidpointRounding.AwayFromZero));

    // ---- origin
    public static ApprovalOriginView OriginOf(ViewDecision decision)
    {
        var origin = decision.Origin; var member = origin?.Kind == "bellteam" && decision.Requester is { } requester ? requester : null;
        var unknown = member is null && origin?.Kind != "external";
        var tool = unknown ? CoreStrings.Approvals_OriginOf_1 : origin?.Tool is { Length: > 0 } t ? t : CoreStrings.Approvals_OriginOf_2;
        var session = origin?.SessionLabel is { Length: > 0 } s ? s : origin?.WorkLabel ?? "";
        var tile = origin?.Client is "claude-code" or "codex" or "cursor" ? "terminal" : origin?.Client is "claude.ai" or "chatgpt" ? "chat" : "globe";
        var via = origin?.Via == "remote" ? CoreStrings.Approvals_OriginOf_3 : origin?.Via == "connector" ? CoreStrings.Approvals_OriginOf_4 : "";
        var name = member is not null ? member.Name ?? "" : unknown ? CoreStrings.Approvals_OriginOf_1 : session.Length > 0 ? $"{tool} · {session}" : tool;
        return new(member, unknown, member is null, tile, tool, session, via, name, member is not null ? member.Name ?? "" : unknown ? CoreStrings.Approvals_OriginOf_6 : tool);
    }

    // ---- time (JST)
    private static readonly TimeSpan Jst = TimeSpan.FromHours(9);
    private static DateTimeOffset? At(string? value) => DateTimeOffset.TryParse(value, CultureInfo.InvariantCulture, DateTimeStyles.AssumeUniversal, out var at) ? at : null;
    private static DateTime Local(DateTimeOffset value) => value.ToOffset(Jst).DateTime;
    public static string Clock(string? value) => At(value) is { } at ? Local(at).ToString(CoreStrings.Pattern_TimePadded) : "";
    public static string AgeText(string? value, DateTimeOffset now)
    {
        if (At(value) is not { } at) return "";
        var minutes = (int)Math.Floor((now - at).TotalMinutes);
        return minutes < 1 ? CoreStrings.Approvals_AgeText_1 : minutes < 60 ? CoreStrings.Approvals_AgeText_2(minutes) : minutes < 1440 ? CoreStrings.Approvals_AgeText_3(minutes / 60) : LatticeStops.StopTime(value, now);
    }
    public static string DayHeading(string? value, DateTimeOffset now)
    {
        if (At(value) is not { } at) return "";
        var day = Local(at).Date; var today = Local(now).Date;
        return day == today ? CoreStrings.Approvals_DayHeading_1 : day == today.AddDays(-1) ? CoreStrings.Approvals_DayHeading_2 : CoreStrings.Approvals_DayHeading_3(day.Month, day.Day);
    }

    // ---- list card
    private static bool Open(ViewDecision d) => d.Status is "pending" or "held";
    public static IReadOnlyList<ApprovalBadge> BadgesOf(ViewDecision decision)
    {
        var list = new List<ApprovalBadge>();
        if (decision.Status == "pending") list.Add(new(CoreStrings.Approvals_BadgesOf_1, "vio", "inbox"));
        if (decision.Status == "held") list.Add(new(CoreStrings.Approvals_BadgesOf_2, "pen", "pause"));
        if (decision.Status == "answered") list.Add(new(CoreStrings.Approvals_BadgesOf_3, "ok", "seal"));
        if (decision.Status == "cancelled") list.Add(new(CoreStrings.Approvals_BadgesOf_4, "pen", "xmark"));
        if (Open(decision) && decision.Urgency == "high") list.Add(new(CoreStrings.Approvals_BadgesOf_5, "amb", "bolt"));
        if (decision.Amended?.Is == true) list.Add(new(CoreStrings.Approvals_BadgesOf_6, "ind", "pencil"));
        if (OriginOf(decision).External) list.Add(new(CoreStrings.Approvals_BadgesOf_7, "pen", "globe"));
        return list;
    }
    public static ApprovalNote LinkNote(ViewDecision decision)
    {
        var origin = OriginOf(decision); var link = decision.Link;
        if (decision.Status == "held") return new(origin.External && link is null ? CoreStrings.Approvals_LinkNote_1 : CoreStrings.Approvals_LinkNote_2, "plain");
        if (link is null) return origin.External ? new(CoreStrings.Approvals_LinkNote_3, "muted") : decision.NotLinked ? new(CoreStrings.Approvals_LinkNote_4, "muted") : new(CoreStrings.Approvals_LinkNote_5, "muted");
        if (link.State == "diverged") return new(CoreStrings.Approvals_LinkNote_6, "plain");
        // by-decision gives ids and state only (no task title): the line says the task without naming it.
        return new(link.Task?.Title is { Length: > 0 } name ? CoreStrings.Approvals_LinkNote_7(name) : CoreStrings.Approvals_LinkNote_8, "link");
    }
    public static ApprovalCardRow CardRow(ViewDecision decision, DateTimeOffset now)
    {
        var origin = OriginOf(decision); var badges = BadgesOf(decision); var note = LinkNote(decision); var chips = new List<string>();
        if (At(decision.Deadline) is not null && Open(decision)) chips.Add(CoreStrings.Approvals_CardRow_1(LatticeStops.StopTime(decision.Deadline, now)));
        if (decision.Options?.Any(option => option.Recommended) == true) chips.Add(CoreStrings.Approvals_CardRow_2);
        var done = decision.Status is "answered" or "cancelled";
        var label = string.Join(CoreStrings.Approvals_CardRow_3, badges.Select(b => b.Text).Append(decision.Title ?? "").Append(origin.Name).Append(chips.FirstOrDefault(chip => chip.StartsWith(CoreStrings.Approvals_CardRow_4, StringComparison.Ordinal)) ?? "").Append(note.Text).Where(part => part.Length > 0));
        return new(decision.Id ?? "", decision.Status ?? "", decision.Title ?? "", badges, note, chips, origin, decision.Urgency == "high" && !done,
            decision.Status == "held" ? LatticeStops.StopTime(decision.UpdatedAt, now) : AgeText(decision.CreatedAt, now), label);
    }

    // ---- 済み
    public static string DoneAt(ViewDecision d) => d.Answer?.AnsweredAt ?? d.UpdatedAt ?? "";
    public static string AnswerText(ViewDecision d)
    {
        if (d.Answer is not { } answer) return "";
        if (answer.Text is { Length: > 0 } text) return CoreStrings.Approvals_AnswerText_1(text);
        return CoreStrings.Approvals_AnswerText_2(d.Options?.FirstOrDefault(option => option.Id == answer.OptionId)?.Label ?? "");
    }
    public static ApprovalBadge? DeliveryBadge(ViewDecision d)
        => d.Status != "answered" ? null : d.Delivery switch
        {
            "unknown" => new(CoreStrings.Approvals_DeliveryBadge_1, "amb", ""), "waiting" => new(CoreStrings.Approvals_DeliveryBadge_2, "vio", ""), "delivered" or "fetched" => new(CoreStrings.Approvals_DeliveryBadge_3, "ok", ""),
            _ => new(CoreStrings.Approvals_DeliveryBadge_4, "pen", "")   // no value yet (or pending): never "届きました" because the status is answered
        };
    public static IReadOnlyList<ApprovalDoneGroup> GroupDone(IEnumerable<ViewDecision> items, DateTimeOffset now)
    {
        var groups = new List<(string Heading, List<ApprovalDoneRow> Rows)>();
        foreach (var d in items.Where(item => item.Status is "answered" or "cancelled").OrderByDescending(item => At(DoneAt(item)) ?? DateTimeOffset.MinValue))
        {
            var heading = DayHeading(DoneAt(d), now);
            if (groups.Count == 0 || groups[^1].Heading != heading) groups.Add((heading, []));
            var cancelled = d.Status == "cancelled";
            groups[^1].Rows.Add(new(d.Id ?? "", d.Title ?? "", cancelled, OriginOf(d), cancelled ? d.CancelReason ?? "" : AnswerText(d), Clock(DoneAt(d)), cancelled ? null : DeliveryBadge(d)));
        }
        return groups.Select(group => new ApprovalDoneGroup(group.Heading, group.Rows)).ToList();
    }

    // ---- answering
    public static string ConfirmText(ViewDecision decision, string label = "", string text = "")
    {
        var origin = OriginOf(decision); var title = decision.Link?.Task?.Title;
        var head = text.Length > 0 ? CoreStrings.Approvals_ConfirmText_1 : CoreStrings.Approvals_ConfirmText_2(label);
        return origin.External && decision.Link is null || string.IsNullOrEmpty(title) ? CoreStrings.Approvals_ConfirmText_3(head, origin.Who) : CoreStrings.Approvals_ConfirmText_4(head, origin.Who, title);
    }
    public static ApprovalDeliveryNote DeliveryNote(ViewDecision decision)
    {
        var origin = OriginOf(decision); var who = origin.Who;
        if (decision.Delivery is not ("waiting" or "unknown" or "delivered" or "fetched")) return new("pen", CoreStrings.Approvals_DeliveryNote_1(who), false);   // nothing reported yet: grey, no paste request
        if (decision.Delivery == "waiting") return new("vio", CoreStrings.Approvals_DeliveryNote_2(who), false);
        if (decision.Delivery == "unknown")
        {
            var next = decision.Link is not null && !origin.External ? CoreStrings.Approvals_DeliveryNote_3 : "";
            return new("amb", CoreStrings.Approvals_DeliveryNote_4(who, next, who), true);
        }
        return new("ok", CoreStrings.Approvals_DeliveryNote_5(who), false);
    }

    // ---- 詳細
    private static string Field(string field) => field switch { "options" => CoreStrings.Approvals_Field_1, "title" => CoreStrings.Approvals_Field_2, "context" => CoreStrings.Approvals_Field_3, "deadline" => CoreStrings.Approvals_CardRow_4, "urgency" => CoreStrings.Approvals_Field_5, "recommendation" => CoreStrings.Approvals_Field_6, _ => CoreStrings.Approvals_OriginOf_2 };
    public static IReadOnlyList<ApprovalHistoryRow> HistoryRows(ViewDecision decision, DateTimeOffset now)
    {
        var who = OriginOf(decision).Who;
        string Stamp(DateTimeOffset at) => Local(at).Date == Local(now).Date ? Clock(at.ToString("O")) : $"{Local(at).ToString(CoreStrings.Pattern_MonthDay)} {Clock(at.ToString("O"))}";
        return (decision.History ?? []).Select(item => (item, at: At(item.At))).Where(pair => pair.at is not null).Select(pair =>
        {
            var (item, at) = (pair.item, pair.at!.Value);
            var text = item.Kind switch
            {
                "created" => CoreStrings.Approvals_HistoryRows_2((item.By == "user" ? CoreStrings.Approvals_HistoryRows_1 : who)),
                "amended" => CoreStrings.Approvals_HistoryRows_5(who, (item.Fields is { Length: > 0 } ? CoreStrings.AppLogin_RefusedText_4(string.Join(CoreStrings.Approvals_CardRow_3, item.Fields.Select(Field))) : "")),
                "held" => CoreStrings.Approvals_HistoryRows_6, "unheld" => CoreStrings.Approvals_HistoryRows_7, "answered" => CoreStrings.Approvals_HistoryRows_8, "cancelled" => CoreStrings.Approvals_HistoryRows_9(who),
                _ => CoreStrings.Approvals_HistoryRows_10
            };
            return new ApprovalHistoryRow(Stamp(at), item.Kind ?? "", text, item.Kind == "amended");
        }).ToList();
    }
    public static ApprovalLinkPanel LinkPanel(ViewDecision decision)
    {
        var origin = OriginOf(decision); var link = decision.Link;
        if (link is null)
            return origin.External
                ? new("unlinked", CoreStrings.Approvals_LinkPanel_1, [CoreStrings.Approvals_LinkPanel_2, CoreStrings.Approvals_LinkPanel_3(origin.Tool),
                    CoreStrings.Approvals_LinkPanel_4], [], null, [], "", "", null)
                : decision.NotLinked ? new("unlinked", CoreStrings.Approvals_LinkNote_4, [], [], null, [], "", "", null)
                : new("connecting", CoreStrings.Approvals_LinkNote_5, [], [], null, [], "", "", null);
        var next = link.Next?.FirstOrDefault(); var answered = link.State == "answered" || decision.Status == "answered"; var title = link.Task?.Title ?? "";
        var named = title.Length > 0 ? CoreStrings.Approvals_LinkPanel_7(title) : CoreStrings.Approvals_LinkPanel_8;
        var sentence = answered ? CoreStrings.Approvals_LinkPanel_9(named)
            : CoreStrings.Approvals_LinkPanel_14((title.Length > 0 ? CoreStrings.Approvals_LinkPanel_10(title) : CoreStrings.Approvals_LinkPanel_8), (next?.Title is { Length: > 0 } nextTitle ? CoreStrings.Approvals_LinkPanel_12(origin.Who, nextTitle) : CoreStrings.Approvals_LinkPanel_13));
        var ids = link.Chart?.ProjectId is { Length: > 0 } project && link.Task?.CardId is { Length: > 0 } card ? new ApprovalLinkIds(project, card) : null;
        return new("linked", "", [], link.Previous ?? [], link.Task, link.Next ?? [], link.Chart?.Name ?? "", sentence, ids);
    }

    // ---- counts and the 出どころ filter
    public static ApprovalCounts CountsOf(ApprovalSummary? summary)
    {
        var answered = summary?.AnsweredToday ?? 0; var filed = Math.Max(summary?.FiledToday ?? 0, answered);
        return new(summary?.Pending ?? 0, summary?.Urgent ?? 0, summary?.Held ?? 0, answered, filed, filed > 0 ? (double)answered / filed : 0);
    }
    public static IReadOnlyList<ViewDecision> OriginFilter(IEnumerable<ViewDecision> items, string filter)
        => filter == "all" ? items.ToList() : items.Where(item => (OriginOf(item).Member is not null ? "bellteam" : "external") == filter).ToList();
    public static ApprovalOriginCounts OriginCounts(IReadOnlyCollection<ViewDecision> items)
    {
        var bellteam = items.Count(item => OriginOf(item).Member is not null);
        return new(items.Count, bellteam, items.Count - bellteam);
    }
    /// <summary>The counts the entry row and the toolbar show, from the device's decisions alone (the server keeps no list since the /v1 close).</summary>
    public static ApprovalSummary SummaryOf(IEnumerable<ViewDecision> device, DateTimeOffset now)
    {
        var list = device.ToList(); bool Today(string? at) => DayHeading(at, now) == "今日";
        return new ApprovalSummary
        {
            Schema = SummarySchema,
            Pending = list.Count(item => item.Status == "pending"),
            Held = list.Count(item => item.Status == "held"),
            Urgent = list.Count(item => item.Status is "pending" or "held" && item.Urgency == "high"),
            AnsweredToday = list.Count(item => item.Status == "answered" && Today(DoneAt(item))),
            FiledToday = list.Count(item => Today(item.CreatedAt)),
        };
    }
    /// <summary>Approval Box's order of the open list (pending and held): 急ぎ度 high first, the nearer 期限 first (none after any), then the older 受付 first. Done ones are the caller's (newest answer first).</summary>
    public static IEnumerable<ViewDecision> OpenOrder(IEnumerable<ViewDecision> items)
        => items.OrderBy(item => item.Urgency switch { "high" => 0, "low" => 2, _ => 1 })
            .ThenBy(item => DateTimeOffset.TryParse(item.Deadline, CultureInfo.InvariantCulture, DateTimeStyles.AssumeUniversal, out var at) ? at : DateTimeOffset.MaxValue)
            .ThenBy(item => DateTimeOffset.TryParse(item.CreatedAt, CultureInfo.InvariantCulture, DateTimeStyles.AssumeUniversal, out var created) ? created : DateTimeOffset.MinValue);
    public static ApprovalEntryView EntryView(ApprovalSummary? summary, ApprovalFailure? status)
    {
        var pending = summary?.Pending ?? 0;
        return new(pending, (summary?.Urgent ?? 0) > 0,
            summary is not null ? (pending > 0 ? CoreStrings.Approvals_EntryView_1 : CoreStrings.Approvals_EntryView_2) : status == ApprovalFailure.Old ? CoreStrings.Approvals_EntryView_3 : CoreStrings.Approvals_EntryView_4,
            pending > 0 ? CoreStrings.Approvals_EntryView_5(pending) : CoreStrings.Approvals_EntryView_6);
    }
}
