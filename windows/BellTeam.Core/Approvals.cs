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
    public const string NotAvailable = "この端末では、決裁箱をまだ使えません。Approval Boxのアプリで答えてください。";
    public const string Loading = "決裁を読んでいます…", Reconnect = "決裁箱に再接続しています…",
        EmptyPending = "決裁はありません。AIが判断を求めると、ここに並びます。", EmptyHeld = "保留中の決裁はありません。", EmptyDone = "まだ済んだ決裁はありません。",
        Retry = "いまは送れませんでした。答えは残っています。少し待って、もう一度押してください。",
        HoldFailed = "いまは保留を切り替えられませんでした。少し待って、もう一度押してください。",
        Waiting = "決裁箱の画面で、許可してください。終わると、ここが自動で読み込みます。", Denied = "許可されませんでした。もう一度つなげます。",
        ConnectFailed = "いまは決裁箱につなげませんでした。少し待って、もう一度押してください。";
    // The Approval Box device states (design peer-channel-signin.md section 3, Delta: the Japanese copy is the contract).
    public const string DeviceSignedOut = "決裁箱を使うには、Approval Boxにサインインします。BellTeamのサインインとは別です。",
        DevicePassEnded = "Approval Boxのサインインが終わりました。もう一度サインインしてください。",
        DeviceAccountDeleted = "Approval Boxのアカウントは削除されました",
        DeviceRemoved = "この端末は、ほかの端末から外されました。",
        DeviceJoining = "この端末を決裁箱につないでいます…",
        DeviceNeedsApproval = "この端末は、まだ承認されていません。Approval Boxを入れた手持ちの端末で承認してください。",
        DeviceNotEntitled = "Approval Boxの契約が必要です。契約はApproval Boxのアプリで行います。",
        DeviceUnknown = "届いたか分かりません。結果が出るまで待ってください。もう一度押しても、答えが二重になることはありません。";
    public const string DeviceAskApproval = "承認をお願いする", DeviceApprovalHow = "Approval Boxのアプリで、この番号を入れるか、QRを読み取ってください。",
        DeviceApprovalExpired = "承認の待ち時間が過ぎました。", DeviceApprovalFailed = "承認できませんでした。もう一度お願いしてください。";
    public static string DeviceApprovalLeft(TimeSpan left) => left.TotalMinutes >= 1 ? $"あと{(int)Math.Ceiling(left.TotalMinutes)}分で切れます" : "まもなく切れます";
    public const string DeviceSigningIn = "ブラウザでサインインしています…";
    public const string DeviceHandoffHow = "Approval Boxのアプリで、設定の「ほかの端末をログインさせる」から読み取ってください。", DeviceHandoffStart = "QRでサインイン";
    // Delta (a490j review): never the runtime's own reason (an exception text); one fixed line.
    public const string DeviceReconnecting = "つなぎ直しています（決裁箱に届きません）";
    public static string Amended(string name) => $"答える前に、{name}が内容を直しました。もう一度、内容を確かめてください。";

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
        var tool = unknown ? "出どころ不明" : origin?.Tool is { Length: > 0 } t ? t : "その他";
        var session = origin?.SessionLabel is { Length: > 0 } s ? s : origin?.WorkLabel ?? "";
        var tile = origin?.Client is "claude-code" or "codex" or "cursor" ? "terminal" : origin?.Client is "claude.ai" or "chatgpt" ? "chat" : "globe";
        var via = origin?.Via == "remote" ? "リモート接続" : origin?.Via == "connector" ? "コネクタ" : "";
        var name = member is not null ? member.Name ?? "" : unknown ? "出どころ不明" : session.Length > 0 ? $"{tool} · {session}" : tool;
        return new(member, unknown, member is null, tile, tool, session, via, name, member is not null ? member.Name ?? "" : unknown ? "出したAI" : tool);
    }

    // ---- time (JST)
    private static readonly TimeSpan Jst = TimeSpan.FromHours(9);
    private static DateTimeOffset? At(string? value) => DateTimeOffset.TryParse(value, CultureInfo.InvariantCulture, DateTimeStyles.AssumeUniversal, out var at) ? at : null;
    private static DateTime Local(DateTimeOffset value) => value.ToOffset(Jst).DateTime;
    public static string Clock(string? value) => At(value) is { } at ? Local(at).ToString("HH:mm", CultureInfo.InvariantCulture) : "";
    public static string AgeText(string? value, DateTimeOffset now)
    {
        if (At(value) is not { } at) return "";
        var minutes = (int)Math.Floor((now - at).TotalMinutes);
        return minutes < 1 ? "たった今" : minutes < 60 ? $"{minutes}分前" : minutes < 1440 ? $"{minutes / 60}時間前" : LatticeStops.StopTime(value, now);
    }
    public static string DayHeading(string? value, DateTimeOffset now)
    {
        if (At(value) is not { } at) return "";
        var day = Local(at).Date; var today = Local(now).Date;
        return day == today ? "今日" : day == today.AddDays(-1) ? "昨日" : $"{day.Month}月{day.Day}日";
    }

    // ---- list card
    private static bool Open(ViewDecision d) => d.Status is "pending" or "held";
    public static IReadOnlyList<ApprovalBadge> BadgesOf(ViewDecision decision)
    {
        var list = new List<ApprovalBadge>();
        if (decision.Status == "pending") list.Add(new("回答待ち", "vio", "inbox"));
        if (decision.Status == "held") list.Add(new("保留", "pen", "pause"));
        if (decision.Status == "answered") list.Add(new("回答済み", "ok", "seal"));
        if (decision.Status == "cancelled") list.Add(new("取り下げ", "pen", "xmark"));
        if (Open(decision) && decision.Urgency == "high") list.Add(new("急ぎ", "amb", "bolt"));
        if (decision.Amended?.Is == true) list.Add(new("修正あり", "ind", "pencil"));
        if (OriginOf(decision).External) list.Add(new("外部から", "pen", "globe"));
        return list;
    }
    public static ApprovalNote LinkNote(ViewDecision decision)
    {
        var origin = OriginOf(decision); var link = decision.Link;
        if (decision.Status == "held") return new(origin.External && link is null ? "保留中です" : "保留中です。戻すまで工程は待ちます", "plain");
        if (link is null) return origin.External ? new("工程表とはつながっていません", "muted") : new("工程表につなげています", "muted");
        if (link.State == "diverged") return new("工程はすでに済みです。この決裁は、まだ答えられます。", "plain");
        // by-decision gives ids and state only (no task title): the line says the task without naming it.
        return new(link.Task?.Title is { Length: > 0 } name ? $"工程表「{name}」が、この回答を待っています" : "工程表の工程が、この回答を待っています", "link");
    }
    public static ApprovalCardRow CardRow(ViewDecision decision, DateTimeOffset now)
    {
        var origin = OriginOf(decision); var badges = BadgesOf(decision); var note = LinkNote(decision); var chips = new List<string>();
        if (At(decision.Deadline) is not null && Open(decision)) chips.Add($"期限 {LatticeStops.StopTime(decision.Deadline, now)}");
        if (decision.Options?.Any(option => option.Recommended) == true) chips.Add("推奨あり");
        var done = decision.Status is "answered" or "cancelled";
        var label = string.Join("、", badges.Select(b => b.Text).Append(decision.Title ?? "").Append(origin.Name).Append(chips.FirstOrDefault(chip => chip.StartsWith("期限", StringComparison.Ordinal)) ?? "").Append(note.Text).Where(part => part.Length > 0));
        return new(decision.Id ?? "", decision.Status ?? "", decision.Title ?? "", badges, note, chips, origin, decision.Urgency == "high" && !done,
            decision.Status == "held" ? LatticeStops.StopTime(decision.UpdatedAt, now) : AgeText(decision.CreatedAt, now), label);
    }

    // ---- 済み
    public static string DoneAt(ViewDecision d) => d.Answer?.AnsweredAt ?? d.UpdatedAt ?? "";
    public static string AnswerText(ViewDecision d)
    {
        if (d.Answer is not { } answer) return "";
        if (answer.Text is { Length: > 0 } text) return $"あなたの指示：{text}";
        return $"あなたの答え：{d.Options?.FirstOrDefault(option => option.Id == answer.OptionId)?.Label ?? ""}";
    }
    public static ApprovalBadge? DeliveryBadge(ViewDecision d)
        => d.Status != "answered" ? null : d.Delivery == "unknown" ? new("届いたか不明", "amb", "") : d.Delivery == "waiting" ? new("会話に戻ると届きます", "vio", "") : new("届きました", "ok", "");
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
        var head = text.Length > 0 ? "この指示を送りますか？ " : $"「{label}」で答えますか？ ";
        return origin.External && decision.Link is null || string.IsNullOrEmpty(title) ? $"{head}答えると、{origin.Who}に届きます。" : $"{head}答えると、{origin.Who}が続きに進み、工程「{title}」が済みになります。";
    }
    public static ApprovalDeliveryNote DeliveryNote(ViewDecision decision)
    {
        var origin = OriginOf(decision); var who = origin.Who;
        if (decision.Delivery == "waiting") return new("vio", $"答えました。{who}が会話に戻ると受け取ります。", false);
        if (decision.Delivery == "unknown")
        {
            var next = decision.Link is not null && !origin.External ? "工程は済みになったので、次の担当にはこちらから知らせます。" : "";
            return new("amb", $"答えは保存しました。ただ、{who}に届いたかを確かめられませんでした。{next}念のため、再開の文を{who}の会話に貼ってください。", true);
        }
        return new("ok", $"答えました。{who}に届きました。", false);
    }

    // ---- 詳細
    private static string Field(string field) => field switch { "options" => "選択肢", "title" => "題名", "context" => "背景", "deadline" => "期限", "urgency" => "急ぎ度", "recommendation" => "推奨", _ => "その他" };
    public static IReadOnlyList<ApprovalHistoryRow> HistoryRows(ViewDecision decision, DateTimeOffset now)
    {
        var who = OriginOf(decision).Who;
        string Stamp(DateTimeOffset at) => Local(at).Date == Local(now).Date ? Clock(at.ToString("O")) : $"{Local(at).Month}/{Local(at).Day} {Clock(at.ToString("O"))}";
        return (decision.History ?? []).Select(item => (item, at: At(item.At))).Where(pair => pair.at is not null).Select(pair =>
        {
            var (item, at) = (pair.item, pair.at!.Value);
            var text = item.Kind switch
            {
                "created" => $"{(item.By == "user" ? "あなた" : who)}が申請しました",
                "amended" => $"{who}が内容を直しました{(item.Fields is { Length: > 0 } ? $"（{string.Join("、", item.Fields.Select(Field))}）" : "")}",
                "held" => "あなたが保留にしました", "unheld" => "保留を戻しました", "answered" => "あなたが答えました", "cancelled" => $"{who}が取り下げました",
                _ => "その他の動きがありました"
            };
            return new ApprovalHistoryRow(Stamp(at), item.Kind ?? "", text, item.Kind == "amended");
        }).ToList();
    }
    public static ApprovalLinkPanel LinkPanel(ViewDecision decision)
    {
        var origin = OriginOf(decision); var link = decision.Link;
        if (link is null)
            return origin.External
                ? new("unlinked", "つながっていません", ["この決裁は、BellTeamの外から届きました。工程は作りません。", $"答えは、出したAI（{origin.Tool}）へそのまま届きます。BellTeamの工程には何も起こりません。",
                    "出したAIが、BellTeamの工程表の工程を指して申請した時だけ（セッション名に工程の宛先がある時）、通常の決裁と同じようにつながります。"], [], null, [], "", "", null)
                : new("connecting", "工程表につなげています", [], [], null, [], "", "", null);
        var next = link.Next?.FirstOrDefault(); var answered = link.State == "answered" || decision.Status == "answered"; var title = link.Task?.Title ?? "";
        var named = title.Length > 0 ? $"工程「{title}」" : "工程";
        var sentence = answered ? $"答えました。{named}は済みです。"
            : $"答えると、{(title.Length > 0 ? $"「{title}」" : "工程")}が済みになり、{(next?.Title is { Length: > 0 } nextTitle ? $"{origin.Who}が「{nextTitle}」へ進めます。" : "次の工程へ進めます。")}答えで決まらない時は、新しい決裁が工程に差し込まれます。";
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
            summary is not null ? (pending > 0 ? "あなたの回答を待っています" : "待っている決裁はありません") : status == ApprovalFailure.Old ? "このサーバーではまだ使えません" : "決裁箱を開く",
            pending > 0 ? $"決裁箱、回答待ち{pending}件" : "決裁箱");
    }
}
