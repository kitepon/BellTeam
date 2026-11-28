using System.Globalization;
using System.Runtime.CompilerServices;
using System.Text.Json;

namespace BellTeam.Core;

// 工程表 (docs/architecture/modules/lattice/README.md "Public contract (apps)"; screen and motion in screen-spec.md).
// The calculations are a port of web/lattice-chart-model.js so the three apps read one snapshot the same way.

public sealed record LatticeChartList { public LatticeChartSummary[] Charts { get; init; } = []; }
public sealed record LatticeChartSummary
{
    public required string ProjectId { get; init; }
    public string? Name { get; init; }
    public bool Coordinator { get; init; }
    public string? CreatedBy { get; init; }
    public LatticeCounts? Counts { get; init; }
    public string[] ActiveMembers { get; init; } = [];
    public DateTimeOffset? UpdatedAt { get; init; }
    public string? State { get; init; }
    /// <summary>The chart's saved 催促 switch (GET /api/lattice/charts only; the snapshot and SSE do not carry it). Missing = no badge.</summary>
    public bool? Reminders { get; init; }
}
public sealed record LatticeCounts(int Total, int Done, int Working, int Blocked, int Connections);
public sealed record LatticeSnapshot
{
    public string? Epoch { get; init; }
    public long Version { get; init; }
    public required string ProjectId { get; init; }
    public string? Name { get; init; }
    public string? CreatedBy { get; init; }
    public bool Coordinator { get; init; }
    public string State { get; init; } = "verified";
    public DateTimeOffset? VerifiedAt { get; init; }
    public string[] Degraded { get; init; } = [];
    public LatticeMember[] Members { get; init; } = [];
    public LatticeCard[] Cards { get; init; } = [];
    /// <summary>a457: `cards` hold only open trees; Closed counts the finished tasks of closed trees, read on demand from the history route. Null (an older server) = 0.</summary>
    public LatticeHistoryInfo? History { get; init; }
    public LatticePhase[] Phases { get; init; } = [];
    public LatticeEdge[] Edges { get; init; } = [];
    /// <summary>The other chart's facts for each open `task` 接続 (a161): named by a connection `ref`, never a card; drawn as text, never on the canvas or tree.</summary>
    public LatticeExternal[] Externals { get; init; } = [];
    /// <summary>The app's Owner profile put on the snapshot by the window (not on the wire): names the reserved owner value. Null while unknown.</summary>
    public string? OwnerName { get; init; }
    public string OwnerAvatarVersion { get; init; } = "";
}
public sealed record LatticeHistoryInfo(int Closed);
/// <summary>One page of GET /api/lattice/charts/:id/history (a457): the finished cards of closed trees, newest first; Next is opaque, null on the last page. A State that is not verified / last_verified carries no cards.</summary>
public sealed record LatticeHistoryPage
{
    public string State { get; init; } = "verified";
    public int Closed { get; init; }
    public LatticeMember[] Members { get; init; } = [];
    public LatticeCard[] Cards { get; init; } = [];
    public string? Next { get; init; }
}
public sealed record LatticeMember(string BotId, string Name, string? Color, string? AvatarVersion);
public sealed record LatticeCard
{
    public required string Id { get; init; }
    public string? Plan { get; init; }
    public string? TaskId { get; init; }
    public string? Title { get; init; }
    public string? DoneCondition { get; init; }
    public string? DesignMemo { get; init; }
    public string State { get; init; } = "pending";
    public string? Producer { get; init; }
    public string? Lane { get; init; }
    public DateTimeOffset? StartedAt { get; init; }
    public DateTimeOffset? ChangedAt { get; init; }
    public string? BlockedReason { get; init; }
    public int Depth { get; init; }
    public string? Phase { get; init; }
    public string? Parent { get; init; }
    public DateTimeOffset? DoneAt { get; init; }
    /// <summary>Finished and none of its next cards is still unstarted: left out of the tree and lanes, kept for 詳細, links and 過去ログ; counted per Counted.</summary>
    public bool Archived { get; init; }
    /// <summary>In the progress fractions: its tree is not fully finished (a96, server rule). Null (an older child) = not archived.</summary>
    public bool? Counted { get; init; }
    public bool IsCounted => Counted ?? !Archived;
    /// <summary>Open 接続 (a161, Lattice 0.104.0; missing = none, an older server): a task of another chart, a schedule or a 優先接続. Never an edge; read through LatticeChart.OpenConnections.</summary>
    public LatticeConnectionEntry[] Connections { get; init; } = [];
}
/// <summary>One 接続 of a card. Kind task (Ref = the externals[] id) | schedule (Ref = its id) | priority (Agent = the Bot that asked); State open or null = open, only those count and draw.</summary>
public sealed record LatticeConnectionEntry(string? Kind, string? Ref, string? Agent, string? Reason, DateTimeOffset? Since, string? State = "open");
public sealed record LatticePhase(string Id, string? Title);
public sealed record LatticeEdge(string From, string To, bool Waiting);
/// <summary>A task of another chart a card connects to: Id = "&lt;projectId&gt;:&lt;plan&gt;/&lt;task&gt;", CardId its card id there; State null = Lattice could not read it.</summary>
public sealed record LatticeExternal(string Id, string ProjectId, string CardId, string? ChartName, string? Title, string? State, bool Finished, string? Producer);
/// <summary>Where a 工程へ移動 on another chart opens: that chart at that card.</summary>
public sealed record LatticeCardRef(string ProjectId, string CardId);
/// <summary>The Approval Box extension's decision for an Owner-lane card (GET /api/approvals/by-task, screen-spec 詳細); Status is a key of LatticeChart.DecisionStates. Title is empty when the server gives ids and state only (after the /v1 close).</summary>
public sealed record LatticeDecision(string DecisionId, string Status, string Title = "");

/// <summary>A member as drawn: the roster entry, or 名簿にないメンバー (Known false, drawn as 「?」 and never opened as a chat).
/// Authored: the plan's written lane text with no member behind it (BotId "", drawn with its initial, never a chat, not in the member rail).
/// IsOwner: the Owner (指揮官, reserved id "owner"): drawn from the Owner profile with a lane of its own, never a chat, not in the member rail.</summary>
public sealed record LatticePerson(string BotId, string Name, string? Color, string AvatarVersion, bool Known, bool Authored = false, bool IsOwner = false)
{
    public bool CanChat => Known && !IsOwner;
}
public sealed record LatticeStateInfo(string Badge, string Tone);
public sealed record LatticeLane(string? BotId, LatticePerson? Member, double Y, double Height);
public sealed record LatticePlaced(double X, double Y, double Width, double Height, int Depth, int Lane);
public sealed record LatticeLayout(IReadOnlyList<LatticeLane> Lanes, IReadOnlyDictionary<string, LatticePlaced> Cards, IReadOnlyList<string> Order, double Width, double Height);
/// <summary>A 接続 panel row (a161): Owner/Headline/OwnerText/Length describe the connected card; Mark says what the entry is; Title, Chart, Producer, StateText, Info and External describe the awaited task (kind task only), Agent the Bot of a 優先接続.</summary>
public sealed record LatticeConnectionRow(string Key, string Kind, string CardId, LatticePerson? Owner, string Headline, string OwnerText, string Length, string Reason, string Mark, LatticePerson? Agent, string Title, string? Chart, LatticePerson? Producer, string StateText, LatticeStateInfo Info, bool Emphasized, bool CanChat, LatticeCardRef? External, string Label);
public sealed record LatticeRailItem(string BotId, LatticePerson Member, bool Working, bool Blocked, int Connections);
public sealed record LatticeLink(string Id, string Title, string State, LatticePerson? Producer, string StateText);
public sealed record LatticeDetail(LatticeCard Card, LatticePerson? Producer, LatticeStateInfo Info, string StateText, IReadOnlyList<LatticeLink> Previous, IReadOnlyList<LatticeLink> Next, string StartedText);
public sealed record LatticeBanner(string Tone, string Text, string Next, bool Dim);
/// <summary>A tree box: Kind root / phase / card. Root and phase carry done/total and the phase tone (blocked, in-progress, done, pending).</summary>
public sealed record LatticeTreeNode(string Key, string Kind, string Label, LatticeCard? Card, double X, double Y, double Width, double Height, int Done, int Total, string Tone);
/// <summary>A soft elbow from the right middle of the parent box to the left middle of the child box.</summary>
public sealed record LatticeTreeLink(string From, string To, double X0, double Y0, double X1, double Y1);
/// <summary>A dependency drawn on the right of both boxes: from (X0,Y0) out to Bulge and back to (X1,Y1), the waiter's right edge.</summary>
public sealed record LatticeTreeArc(string From, string To, bool Waiting, double X0, double Y0, double Bulge, double X1, double Y1);
public sealed record LatticeHistoryRow(string Id, LatticeCard Card, LatticePerson? Owner, LatticeStateInfo Info, string Time, string Label);
public sealed record LatticeHistoryGroup(string Heading, IReadOnlyList<LatticeHistoryRow> Rows);
public sealed record LatticeHistory(int Count, IReadOnlyList<LatticeHistoryGroup> Groups);
public sealed record LatticeTreeLayout(IReadOnlyList<LatticeTreeNode> Nodes, IReadOnlyList<LatticeTreeLink> Links, IReadOnlyList<LatticeTreeArc> Arcs, IReadOnlyDictionary<string, LatticeTreeNode> Cards, double Width, double Height);
public sealed record LatticeDiff(bool First, IReadOnlyList<string> AddedCards, IReadOnlyList<string> ChangedCards, IReadOnlyList<string> CompletedCards);
public sealed record LatticeListItem(string ProjectId, string Name, bool Coordinator, int Done, int Total, int Connections, IReadOnlyList<LatticePerson> Members, double Fraction, string Updated, string Label, bool Reminders = false);

public static class LatticeChart
{
    public static string UnknownMember  => CoreStrings.LatticeChart_UnknownMember_1;
    public static string Unassigned  => CoreStrings.LatticeChart_Unassigned_1;
    public const string OwnerId = "owner";
    public static string OwnerFallback  => CoreStrings.LatticeChart_OwnerFallback_1;
    public static string Reconnecting  => CoreStrings.LatticeChart_Reconnecting_1;
    public static string ListEmpty  => CoreStrings.LatticeChart_ListEmpty_1;
    public static string NewChart  => CoreStrings.LatticeChart_NewChart_1;
    public static string OldServer  => CoreStrings.LatticeChart_OldServer_1;
    public static string OldServerNext  => CoreStrings.LatticeChart_OldServerNext_1;
    public static string NotFound  => CoreStrings.LatticeChart_NotFound_1;
    public static string Unavailable  => CoreStrings.LatticeChart_Unavailable_1;
    public static string UnavailableNext  => CoreStrings.LatticeChart_UnavailableNext_1;
    public static string NoCards  => CoreStrings.LatticeChart_NoCards_1;
    public static string LoginRequired  => CoreStrings.LatticeChart_LoginRequired_1;
    public static readonly IReadOnlyDictionary<string, string> DecisionStates = new Dictionary<string, string> { ["pending"] = CoreStrings.LatticeChart_DecisionStates_1, ["held"] = CoreStrings.Approvals_BadgesOf_2, ["answered"] = CoreStrings.Approvals_BadgesOf_3, ["cancelled"] = CoreStrings.Approvals_BadgesOf_4 };
    /// <summary>web decisionOf: a non-empty decisionId and a known status (the title is optional: ids and state only since the /v1 close), else null (no 決裁 block).</summary>
    public static LatticeDecision? DecisionOf(JsonElement value)
        => value.ValueKind == JsonValueKind.Object && value.TryGetProperty("decisionId", out var id) && id.ValueKind == JsonValueKind.String && id.GetString() is { Length: > 0 } decisionId
            && value.TryGetProperty("status", out var status) && status.ValueKind == JsonValueKind.String && DecisionStates.ContainsKey(status.GetString()!)
            ? new LatticeDecision(decisionId, status.GetString()!, value.TryGetProperty("title", out var title) && title.ValueKind == JsonValueKind.String ? title.GetString()! : "") : null;

    public static LatticeStateInfo StateInfo(string? state) => state switch
    {
        "ready" => new(CoreStrings.LatticeChart_StateInfo_1, "ready"), "in-progress" => new(CoreStrings.LatticeChart_StateInfo_2, "working"), "blocked" => new(CoreStrings.LatticeChart_StateInfo_3, "blocked"),
        "done" => new(CoreStrings.GoalModels_StatusTitle_6, "done"), "retired" => new(CoreStrings.Approvals_BadgesOf_4, "retired"), _ => new(CoreStrings.LatticeChart_StateInfo_6, "pending")
    };
    public static bool Finished(string? state) => state is "done" or "retired";

    /// <summary>The chart's name everywhere it is named: its name, else 「作った人の工程表」 from the app's roster, else 名前のない工程表. The project id never appears.</summary>
    public static string ChartName(string? name, string? createdBy, Func<string, string?> rosterName)
        => name is { Length: > 0 } ? name : createdBy is { Length: > 0 } && rosterName(createdBy) is { Length: > 0 } creator ? CoreStrings.LatticeChart_ChartName_1(creator) : CoreStrings.LatticeChart_ChartName_2;

    // Reconnect wait: 1, 2, 4 … 30 s (each ±20%), forever while open.
    public static int BackoffMs(int attempt, Func<double>? random = null)
        => (int)Math.Min(30000, Math.Round(Math.Min(30000, 1000 * Math.Pow(2, Math.Max(0, attempt))) * (0.8 + 0.4 * (random ?? Random.Shared.NextDouble)())));

    private static readonly TimeZoneInfo Jst = TimeZoneInfo.CreateCustomTimeZone("JST", TimeSpan.FromHours(9), "JST", "JST");
    public static string FormatJst(DateTimeOffset? value) => value is { } at ? TimeZoneInfo.ConvertTime(at, Jst).ToString(CoreStrings.LatticeChart_FormatJst_1) : "";
    public static string SinceText(DateTimeOffset? value, DateTimeOffset now)
    {
        var minutes = value is { } at ? Math.Max(0, (int)Math.Floor((now - at).TotalMinutes)) : 0;
        if (minutes < 1) return CoreStrings.LatticeChart_SinceText_1;
        if (minutes < 60) return CoreStrings.LatticeChart_SinceText_2(minutes);
        if (minutes < 1440) return minutes % 60 != 0 ? CoreStrings.LatticeChart_SinceText_3(minutes / 60, minutes % 60) : CoreStrings.LatticeChart_SinceText_4(minutes / 60);
        return CoreStrings.LatticeChart_SinceText_5(minutes / 1440);
    }

    public static Func<string?, LatticePerson?> Lookup(LatticeSnapshot snapshot)
    {
        var roster = snapshot.Members.GroupBy(member => member.BotId).ToDictionary(group => group.Key, group => group.First());
        // The reserved owner value is the Owner (指揮官), who has no Bot id: drawn from the Owner profile, never the raw word.
        var owner = new LatticePerson(OwnerId, snapshot.OwnerName is { Length: > 0 } name ? name : OwnerFallback, "amber", snapshot.OwnerAvatarVersion, true, IsOwner: true);
        return botId => botId is not { Length: > 0 } ? null : botId == OwnerId ? owner : roster.TryGetValue(botId, out var member)
            ? new LatticePerson(botId, member.Name, member.Color, member.AvatarVersion ?? "", true)
            : new LatticePerson(botId, UnknownMember, null, "", false);
    }
    public static string NameOf(LatticePerson? member) => member?.Name ?? Unassigned;
    /// <summary>A card's owner on screen (lattice README "Owner on screen"): its producer, else its authored lane text as written, else null (担当なし).</summary>
    public static Func<LatticeCard?, LatticePerson?> Owner(LatticeSnapshot snapshot)
    {
        var lookup = Lookup(snapshot);
        return card => card?.Producer is { Length: > 0 } producer ? lookup(producer) : card?.Lane is { Length: > 0 } lane ? new LatticePerson("", lane, null, "", false, true) : null;
    }

    // Lanes per owner (known members by name, then authored lane texts by name, then unknown members, then 担当なし), columns by depth; cards of one lane and depth stack.
    public const double CardWidth = 168;
        public const double CardHeight = 108;
        public const double CardDoneHeight = 50;
        public const double ColumnWidth = 236;
        public const double LabelWidth = 132;
        public const double Top = 14;
        public const double LaneMin = 116;
        public const double LaneGap = 10;
        public const double LanePad = 10;
        public const double StackGap = 10;
    public static double HeightOf(LatticeCard card) => Finished(card.State) ? CardDoneHeight : CardHeight;
    public static LatticeLayout Layout(LatticeSnapshot snapshot)
    {
        var ownerOf = Owner(snapshot); var owners = new Dictionary<string, LatticePerson?>();
        string Key(LatticeCard card) { var owner = ownerOf(card); var key = owner is null ? "" : owner.Authored ? "lane:" + owner.Name : owner.BotId; owners[key] = owner; return key; }
        var groups = snapshot.Cards.Where(card => !card.Archived).GroupBy(Key).ToDictionary(group => group.Key, group => group.ToList());
        int Rank(string key) => owners[key] is not { } owner ? 3 : owner.Known ? 0 : owner.Authored ? 1 : 2;
        var order = groups.Keys.OrderBy(Rank).ThenBy(key => Rank(key) < 2 ? owners[key]!.Name : "", StringComparer.Create(CultureInfo.GetCultureInfo("ja-JP"), false)).ThenBy(key => key, StringComparer.Ordinal).ToList();
        var lanes = new List<LatticeLane>(); var placed = new Dictionary<string, LatticePlaced>();
        double y = Top; var maxDepth = 0;
        foreach (var key in order)
        {
            var cells = groups[key].OrderBy(card => card.Id, StringComparer.Ordinal).GroupBy(card => Math.Max(0, card.Depth)).ToDictionary(group => group.Key, group => group.ToList());
            double Stack(List<LatticeCard> list) => list.Sum(HeightOf) + StackGap * (list.Count - 1);
            var height = Math.Max(LaneMin, cells.Values.Max(list => Stack(list) + LanePad * 2));
            foreach (var (depth, list) in cells)
            {
                maxDepth = Math.Max(maxDepth, depth);
                var top = y + (height - Stack(list)) / 2;
                foreach (var card in list) { placed[card.Id] = new(LabelWidth + 16 + depth * ColumnWidth, top, CardWidth, HeightOf(card), depth, lanes.Count); top += HeightOf(card) + StackGap; }
            }
            lanes.Add(new(owners[key] is { Authored: false } member ? member.BotId : null, owners[key], y, height));
            y += height + LaneGap;
        }
        var reading = placed.OrderBy(pair => pair.Value.Lane).ThenBy(pair => pair.Value.Depth).ThenBy(pair => pair.Value.Y).Select(pair => pair.Key).ToList();
        return new(lanes, placed, reading, LabelWidth + 16 + (maxDepth + 1) * ColumnWidth + 24, y + 40);
    }

    // ツリー (screen-spec "ツリー"): chart -> phases -> cards (under `parent`, else their phase, else the chart). Leaves take one row each, a parent sits at the
    // middle of its children. Port of layoutTree in web/lattice-chart-model.js; sizes are the Web px.
    public const double TreeRow = 40;
            public const double TreeBoxHeight = 32;
            public const double TreeGap = 36;
            public const double TreeTop = 16;
            public const double TreeLeft = 16;
            public const double TreeRootWidth = 168;
            public const double TreePhaseWidth = 196;
            public const double TreeCardWidth = 300;
    public static string UnnamedPhase  => CoreStrings.LatticeChart_UnnamedPhase_1;
    public static string PhaseTone(IEnumerable<LatticeCard> cards)
    {
        var list = cards.ToList();
        return list.Any(card => card.State == "blocked") ? "blocked" : list.Any(card => card.State == "in-progress") ? "in-progress" : list.Count > 0 && list.All(card => Finished(card.State)) ? "done" : "pending";
    }
    private sealed class Draft(string key, string kind, string label, LatticeCard? card, double width)
    {
        public string Key = key, Kind = kind, Label = label; public LatticeCard? Card = card; public double Width = width, X, Y; public List<string> Children = [];
    }
    public static LatticeTreeLayout Tree(LatticeSnapshot snapshot, string name)
    {
        // Archived cards are not drawn; a phase whose cards are all archived is not drawn; an archived parent's children hang from their phase.
        var all = snapshot.Cards.GroupBy(card => card.Id).Select(group => group.First()).ToList();
        var byId = all.Where(card => !card.Archived).ToDictionary(card => card.Id);
        var drafts = new Dictionary<string, Draft> { ["root"] = new("root", "root", name, null, TreeRootWidth) };
        foreach (var phase in snapshot.Phases.Where(phase => !all.Any(card => card.Phase == phase.Id) || byId.Values.Any(card => card.Phase == phase.Id))) drafts.TryAdd("phase:" + phase.Id, new("phase:" + phase.Id, "phase", phase.Title is { Length: > 0 } title ? title : UnnamedPhase, null, TreePhaseWidth));
        foreach (var card in byId.Values) drafts.TryAdd(card.Id, new(card.Id, "card", Title(card), card, TreeCardWidth));
        foreach (var draft in drafts.Values.Where(draft => draft.Kind == "phase").ToList()) drafts["root"].Children.Add(draft.Key);
        foreach (var card in byId.Values)
            drafts[card.Parent is { } parent && byId.ContainsKey(parent) && parent != card.Id ? parent : card.Phase is { } phase && drafts.ContainsKey("phase:" + phase) ? "phase:" + phase : "root"].Children.Add(card.Id);
        // seen guards a parent cycle the server did not drop: each box is placed once.
        var row = 0; var right = 0.0; var seen = new HashSet<string>();
        void Place(string key, double x)
        {
            var draft = drafts[key]; seen.Add(key); draft.X = x; right = Math.Max(right, x + draft.Width);
            var kids = draft.Children.Where(child => !seen.Contains(child)).ToList();
            foreach (var child in kids) Place(child, x + draft.Width + TreeGap);
            draft.Y = kids.Count > 0 ? (drafts[kids[0]].Y + drafts[kids[^1]].Y) / 2 : TreeTop + row++ * TreeRow;
        }
        Place("root", TreeLeft);
        var counted = all.Where(card => card.IsCounted).ToList();
        var nodes = drafts.Values.Where(draft => seen.Contains(draft.Key)).Select(draft =>
        {
            // done/total count the counted cards, like the ring (a96): the chart all of them, a phase the counted cards of that phase.
            var inside = draft.Kind switch { "card" => [], "root" => counted, _ => counted.Where(card => "phase:" + card.Phase == draft.Key).ToList() };
            return new LatticeTreeNode(draft.Key, draft.Kind, draft.Label, draft.Card, draft.X, draft.Y, draft.Width, TreeBoxHeight, inside.Count(card => Finished(card.State)), inside.Count, PhaseTone(inside));
        }).ToList();
        var placed = nodes.ToDictionary(node => node.Key);
        double Mid(LatticeTreeNode node) => node.Y + node.Height / 2;
        var links = drafts.Values.Where(draft => placed.ContainsKey(draft.Key)).SelectMany(draft => draft.Children.Where(placed.ContainsKey).Select(child =>
            new LatticeTreeLink(draft.Key, child, placed[draft.Key].X + placed[draft.Key].Width, Mid(placed[draft.Key]), placed[child].X, Mid(placed[child])))).ToList();
        var reach = right;
        var arcs = snapshot.Edges.Where(edge => placed.TryGetValue(edge.From, out var a) && a.Kind == "card" && placed.TryGetValue(edge.To, out var b) && b.Kind == "card").Select(edge =>
        {
            var a = placed[edge.From]; var b = placed[edge.To]; double x0 = a.X + a.Width, x1 = b.X + b.Width;
            var bulge = Math.Max(x0, x1) + 24 + Math.Min(160, Math.Abs(Mid(b) - Mid(a)) * .3); reach = Math.Max(reach, bulge);
            return new LatticeTreeArc(edge.From, edge.To, edge.Waiting, x0, Mid(a), bulge, x1 + 6, Mid(b));
        }).ToList();
        return new(nodes, links, arcs, nodes.Where(node => node.Kind == "card").ToDictionary(node => node.Key), reach + 24, TreeTop + Math.Max(1, row) * TreeRow + 16);
    }

    /// <summary>The 過去ログ switch count (a457): finished cards of the snapshot + the finished tasks of closed trees. Needs no request.</summary>
    public static int HistoryCount(LatticeSnapshot snapshot) => snapshot.Cards.Count(card => Finished(card.State)) + (snapshot.History?.Closed ?? 0);
    /// <summary>The snapshot with the loaded history pages' cards and members added for 過去ログ and 詳細 only (the tree and lanes keep the snapshot); a card already in the snapshot wins (a reopened tree), a known member keeps the snapshot's entry.</summary>
    public static LatticeSnapshot WithHistory(LatticeSnapshot snapshot, IReadOnlyList<LatticeHistoryPage> pages)
    {
        if (pages.Count == 0) return snapshot;
        var ids = snapshot.Cards.Select(card => card.Id).ToHashSet(); var bots = snapshot.Members.Select(member => member.BotId).ToHashSet();
        return snapshot with
        {
            Cards = [.. snapshot.Cards, .. pages.SelectMany(page => page.Cards).Where(card => ids.Add(card.Id))],
            Members = [.. snapshot.Members, .. pages.SelectMany(page => page.Members).Where(member => bots.Add(member.BotId))]
        };
    }

    /// <summary>過去ログ: every finished card, newest doneAt first, under JST day headings 今日 / 昨日 / M月d日; cards without doneAt last under 日時の分からない工程.</summary>
    public static LatticeHistory History(LatticeSnapshot snapshot, DateTimeOffset now)
    {
        var ownerOf = Owner(snapshot);
        DateTimeOffset Local(DateTimeOffset at) => TimeZoneInfo.ConvertTime(at, Jst);
        var today = Local(now).Date; var groups = new List<(string Heading, List<LatticeHistoryRow> Rows)>();
        var rows = snapshot.Cards.Where(card => Finished(card.State)).OrderByDescending(card => card.DoneAt ?? DateTimeOffset.MinValue).ThenBy(card => card.Id, StringComparer.Ordinal).ToList();
        foreach (var card in rows)
        {
            var day = card.DoneAt is { } at ? Local(at).Date : (DateTime?)null;
            var heading = day is not { } date ? CoreStrings.LatticeChart_History_1 : date == today ? CoreStrings.Approvals_DayHeading_1 : date == today.AddDays(-1) ? CoreStrings.Approvals_DayHeading_2 : date.ToString(CoreStrings.LatticeChart_History_4);
            if (groups.Count == 0 || groups[^1].Heading != heading) groups.Add((heading, []));
            var owner = ownerOf(card); var info = StateInfo(card.State); var time = card.DoneAt is { } done ? Local(done).ToString(CoreStrings.Pattern_TimePadded) : "";
            groups[^1].Rows.Add(new(card.Id, card, owner, info, time, CoreStrings.LatticeChart_History_6(Title(card), info.Badge, (time.Length > 0 ? CoreStrings.LatticeChart_History_5(heading, time) : ""), NameOf(owner))));
        }
        return new(rows.Count, groups.Select(group => new LatticeHistoryGroup(group.Heading, group.Rows)).ToList());
    }

    /// <summary>An edge is a smooth curve from the right middle of the producer card to the left middle of the waiting card.</summary>
    public static (double X0, double Y0, double X1, double Y1, double X2, double Y2, double X3, double Y3) EdgeCurve(LatticePlaced from, LatticePlaced to)
    {
        double x0 = from.X + from.Width, y0 = from.Y + from.Height / 2, x3 = to.X, y3 = to.Y + to.Height / 2, dx = Math.Max(36, (x3 - x0) / 2);
        return (x0, y0, x0 + dx, y0, x3 - dx, y3, x3, y3);
    }
    public static (double X, double Y) PointOnCurve((double X0, double Y0, double X1, double Y1, double X2, double Y2, double X3, double Y3) c, double t)
    {
        var u = 1 - t;
        return (u * u * u * c.X0 + 3 * u * u * t * c.X1 + 3 * u * t * t * c.X2 + t * t * t * c.X3, u * u * u * c.Y0 + 3 * u * u * t * c.Y1 + 3 * u * t * t * c.Y2 + t * t * t * c.Y3);
    }
    public const double FlowSpawnMs = 600;
    public const double FlowTravelMs = 1400;
    /// <summary>Waiting edge particles: one every 600 ms, 1.4 s toward the waiter. The progress (0..1) of each particle in flight.</summary>
    public static IEnumerable<double> FlowPositions(double nowMs)
    {
        for (var n = Math.Floor(nowMs / FlowSpawnMs); n * FlowSpawnMs > nowMs - FlowTravelMs; n--) yield return (nowMs - n * FlowSpawnMs) / FlowTravelMs;
    }
    public static double ParticleOpacity(double t) => Math.Max(0, Math.Min(1, Math.Min(t / 0.07, (1 - t) / 0.23)));

    /// <summary>The card's open 接続: an entry with no state counts as open, a settled one or an unknown kind does not (a161).</summary>
    public static IEnumerable<LatticeConnectionEntry> OpenConnections(LatticeCard card)
        => (card.Connections ?? []).Where(entry => entry.State is null or "open" && entry.Kind is "task" or "schedule" or "priority");

    public static LatticeCounts Counts(LatticeSnapshot snapshot)
    {
        // Only counted cards (a96); an uncounted card is in a finished tree, so working / blocked / connections are unchanged. 接続 = the open entries.
        var cards = snapshot.Cards.Where(card => card.IsCounted).ToList();
        return new(cards.Count, cards.Count(card => Finished(card.State)), cards.Count(card => card.State == "in-progress"),
            cards.Count(card => card.State == "blocked"), cards.Sum(card => OpenConnections(card).Count()));
    }

    /// <summary>作業中 N分 / ブロック: 理由 / 未着手: 担当 ◯◯ / 担当なし.</summary>
    public static string ProducerStateText(LatticeCard? card, string? state, LatticePerson? member, DateTimeOffset now)
    {
        var info = StateInfo(state);
        return state switch
        {
            "in-progress" => $"{info.Badge} {SinceText(card?.StartedAt, now)}",
            "blocked" => card?.BlockedReason is { Length: > 0 } reason ? $"{info.Badge}: {reason}" : info.Badge,
            "pending" or "ready" => member is not null ? CoreStrings.LatticeChart_ProducerStateText_1(info.Badge, member.Name) : Unassigned,
            _ => info.Badge
        };
    }
    public static string CardLabel(LatticeCard card, LatticePerson? member)
        => CoreStrings.LatticeChart_CardLabel_2(Title(card), StateInfo(card.State).Badge, NameOf(member), (OpenConnections(card).Any() ? CoreStrings.LatticeChart_CardLabel_1(OpenConnections(card).Count()) : ""));
    public static string Title(LatticeCard? card) => card?.Title is { Length: > 0 } title ? title : CoreStrings.LatticeChart_Title_1;
    /// <summary>The line under a card: the reason when blocked, the producer when not started, who is making it while in progress.</summary>
    public static string CardNote(LatticeCard card, LatticePerson? member) => card.State switch
    {
        "blocked" => card.BlockedReason ?? "",
        "pending" or "ready" => member is not null ? CoreStrings.LatticeChart_CardNote_1(member.Name) : Unassigned,
        "in-progress" => member is not null ? CoreStrings.LatticeChart_CardNote_2(member.Name) : "",
        _ => ""
    };

    // 別の工程表の工程につながる接続 (externals[], screen-spec 接続 and ブロック): title and chart name fall back to words, an unread state reads 読めていません.
    public static string ExternalUnread  => CoreStrings.LatticeChart_ExternalUnread_1;
    private static Dictionary<string, LatticeExternal> Externals(LatticeSnapshot snapshot) => (snapshot.Externals ?? []).GroupBy(ext => ext.Id).ToDictionary(group => group.Key, group => group.First());
    public static string ExternalTitle(LatticeExternal ext) => ext.Title is { Length: > 0 } title ? title : CoreStrings.LatticeChart_ExternalTitle_1;
    public static string ExternalChart(LatticeExternal ext) => CoreStrings.LatticeChart_ChartName_1((ext.ChartName is { Length: > 0 } name ? name : CoreStrings.LatticeChart_ExternalChart_1));
    // A task of another chart carries no start time, so 作業中 has no minutes.
    private static string ExternalState(LatticeExternal ext, LatticePerson? producer, DateTimeOffset now)
        => ext.State is null ? ExternalUnread : ext.State == "in-progress" ? StateInfo(ext.State).Badge : ProducerStateText(null, ext.State, producer, now);
    private static string ConnectionKey(LatticeCard card, LatticeConnectionEntry entry) => $"{card.Id}>{entry.Kind}:{entry.Ref ?? entry.Agent ?? ""}";
    private static IEnumerable<(LatticeCard Card, LatticeConnectionEntry Entry)> OpenEntries(LatticeSnapshot snapshot) => snapshot.Cards.SelectMany(card => OpenConnections(card).Select(entry => (card, entry)));

    /// <summary>The 接続 panel rows (a161): every open entry of every card, oldest since first. Fed only by card connections, never by edges; a connection is never a line.</summary>
    public static IReadOnlyList<LatticeConnectionRow> ConnectionRows(LatticeSnapshot snapshot, DateTimeOffset now)
    {
        var lookup = Lookup(snapshot); var ownerOf = Owner(snapshot); var externals = Externals(snapshot);
        return OpenEntries(snapshot).OrderBy(item => item.Entry.Since ?? DateTimeOffset.MaxValue).ThenBy(item => item.Card.Id, StringComparer.Ordinal).Select(item =>
        {
            var (card, entry) = item; var owner = ownerOf(card); var ownerText = owner is null ? Unassigned : CoreStrings.LatticeChart_CardNote_1(owner.Name); var headline = Title(card); var who = CoreStrings.LatticeChart_ConnectionRows_2(headline, ownerText);
            LatticeConnectionRow Row(string mark, string label, LatticePerson? agent = null, string title = "", string? chart = null, LatticePerson? producer = null, string stateText = "", LatticeStateInfo? info = null, bool emphasized = false, LatticeCardRef? external = null)
                => new(ConnectionKey(card, entry), entry.Kind!, card.Id, owner, headline, ownerText, SinceText(entry.Since, now), entry.Reason ?? "", mark, agent, title, chart, producer, stateText, info ?? StateInfo(null), emphasized, producer?.CanChat == true, external, label);
            if (entry.Kind == "schedule") return Row(CoreStrings.LatticeChart_ConnectionRows_3, CoreStrings.LatticeChart_ConnectionRows_4(who));
            if (entry.Kind == "priority")
            {
                var agent = lookup(entry.Agent); var mark = CoreStrings.LatticeChart_ConnectionRows_5(NameOf(agent));
                return Row(mark, who + mark, agent);
            }
            var id = entry.Ref ?? ""; var colon = id.IndexOf(':');
            var ext = externals.GetValueOrDefault(id) ?? new LatticeExternal(id, colon < 0 ? id : id[..colon], colon < 0 ? "" : id[(colon + 1)..], null, null, null, false, null);
            var producer = ext.Producer is { Length: > 0 } maker ? lookup(maker) : null; var title = ExternalTitle(ext); var chart = ExternalChart(ext); var state = ExternalState(ext, producer, now);
            return Row(CoreStrings.LatticeChart_ConnectionRows_6, CoreStrings.LatticeChart_ConnectionRows_7(who, title, chart, NameOf(producer), state), null, title, chart, producer, state, StateInfo(ext.State), ext.State == "blocked", new(ext.ProjectId, ext.CardId));
        }).ToList();
    }
    /// <summary>The chip on a line to a card still being made: 「前工程：◯◯」, ◯◯ = the owner of the card the edge starts from, 担当なし when it has none.</summary>
    public static string EdgeChip(LatticeSnapshot snapshot, LatticeEdge edge)
        => CoreStrings.LatticeChart_EdgeChip_1(Owner(snapshot)(snapshot.Cards.FirstOrDefault(card => card.Id == edge.From))?.Name ?? Unassigned);
    public static IReadOnlyList<LatticeRailItem> Rail(LatticeSnapshot snapshot, LatticeLayout layout)
        => layout.Lanes.Where(lane => lane.BotId is not null && lane.Member?.IsOwner != true).Select(lane => new LatticeRailItem(lane.BotId!, lane.Member!,
            snapshot.Cards.Any(card => card.Producer == lane.BotId && card.State == "in-progress"), snapshot.Cards.Any(card => card.Producer == lane.BotId && card.State == "blocked"),
            snapshot.Cards.Count(card => card.Producer == lane.BotId && OpenConnections(card).Any()))).ToList();

    /// <summary>The member's cards and their 接続 (the card's owner, who makes the awaited task, or who asked for a 優先接続); everything else dims.</summary>
    public static (HashSet<string> Cards, HashSet<string> Connections) Highlight(LatticeSnapshot snapshot, string botId)
    {
        var makers = Externals(snapshot).ToDictionary(pair => pair.Key, pair => pair.Value.Producer);
        return (snapshot.Cards.Where(card => card.Producer == botId).Select(card => card.Id).ToHashSet(),
            OpenEntries(snapshot).Where(item => item.Card.Producer == botId || item.Entry.Agent == botId || item.Entry.Ref is { } id && makers.GetValueOrDefault(id) == botId).Select(item => ConnectionKey(item.Card, item.Entry)).ToHashSet());
    }

    public static LatticeDetail? Detail(LatticeSnapshot snapshot, string cardId, DateTimeOffset now)
    {
        var cards = snapshot.Cards.GroupBy(card => card.Id).ToDictionary(group => group.Key, group => group.First());
        if (!cards.TryGetValue(cardId, out var card)) return null;
        var ownerOf = Owner(snapshot);
        LatticeLink? Link(string id) => cards.TryGetValue(id, out var other) ? new(id, Title(other), other.State, ownerOf(other), ProducerStateText(other, other.State, ownerOf(other), now)) : null;
        return new(card, ownerOf(card), StateInfo(card.State), ProducerStateText(card, card.State, ownerOf(card), now),
            snapshot.Edges.Where(edge => edge.To == cardId).Select(edge => Link(edge.From)).OfType<LatticeLink>().ToList(),
            snapshot.Edges.Where(edge => edge.From == cardId).Select(edge => Link(edge.To)).OfType<LatticeLink>().Where(link => link.State != "retired").ToList(),   // a retired card is no live successor (a185, as Web)
            card.StartedAt is { } started ? CoreStrings.LatticeChart_Detail_1(FormatJst(started)) : CoreStrings.LatticeChart_Detail_2);
    }

    public static LatticeBanner? Banner(LatticeSnapshot snapshot) => snapshot.State switch
    {
        "unverified" => new("amber", CoreStrings.LatticeChart_Banner_1, CoreStrings.LatticeChart_Banner_2, false),
        "last_verified" => new("grey", CoreStrings.LatticeChart_Banner_4((snapshot.VerifiedAt is { } at ? CoreStrings.LatticeChart_Banner_3(FormatJst(at)) : "")), CoreStrings.LatticeChart_Banner_5, true),
        _ => null
    };
    public static IReadOnlyList<string> DegradedPills(LatticeSnapshot snapshot)
        => snapshot.Degraded.Select(key => key switch { "lattice-read" => CoreStrings.LatticeChart_DegradedPills_1, "members" => CoreStrings.LatticeChart_DegradedPills_2, _ => null }).OfType<string>().Distinct().ToList();

    public static LatticeDiff Diff(LatticeSnapshot? previous, LatticeSnapshot next)
    {
        if (previous is null) return new(true, [], [], []);
        var before = previous.Cards.GroupBy(card => card.Id).ToDictionary(group => group.Key, group => group.First());
        List<string> added = [], changed = [], completed = [];
        foreach (var card in next.Cards)
        {
            if (!before.TryGetValue(card.Id, out var old)) added.Add(card.Id);
            else if (old.State != card.State) { changed.Add(card.Id); if (card.State == "done" && old.State != "retired") completed.Add(card.Id); }
        }
        return new(false, added, changed, completed);
    }

    /// <summary>Charts 一覧 shows (shownCharts): a chart whose list counts.total is 0 has nothing to open (Owner 2026-11-14, a107). Member chart buttons read the full list.</summary>
    public static LatticeChartSummary[] Shown(LatticeChartList list) => list.Charts.Where(chart => (chart.Counts?.Total ?? 0) > 0).ToArray();
    /// <summary>List cards of the shown charts in the server's order (coordinator charts first). Active members come from the app's roster; one not in it is 「?」.</summary>
    public static IReadOnlyList<LatticeListItem> ListItems(LatticeChartList list, Func<string, LatticePerson?> roster)
        => Shown(list).Select(chart =>
        {
            var members = chart.ActiveMembers.Take(4).Select(id => roster(id) ?? new LatticePerson(id, UnknownMember, null, "", false)).ToList();
            var counts = chart.Counts ?? new(0, 0, 0, 0, 0);
            var name = ChartName(chart.Name, chart.CreatedBy, id => roster(id)?.Name);
            return new LatticeListItem(chart.ProjectId, name, chart.Coordinator, counts.Done, counts.Total, counts.Connections, members,
                counts.Total > 0 ? Math.Min(1, (double)counts.Done / counts.Total) : 0, chart.UpdatedAt is { } at ? CoreStrings.LatticeChart_ListItems_1(FormatJst(at)) : "",
                CoreStrings.LatticeChart_ListItems_6(name, (chart.Coordinator ? CoreStrings.LatticeChart_ListItems_2 : ""), counts.Done, counts.Total, counts.Connections, (chart.Reminders == true ? CoreStrings.LatticeChart_ListItems_3 : ""), (members.Count > 0 ? CoreStrings.LatticeChart_ListItems_5(string.Join(CoreStrings.Approvals_CardRow_3, members.Select(member => member.Name))) : "")), chart.Reminders == true);
        }).ToList();
    public static string? CoordinatorBotId(LatticeChartList list) => list.Charts.FirstOrDefault(chart => chart.Coordinator && chart.CreatedBy is { Length: > 0 })?.CreatedBy;
}

public enum LatticeConnection { Connecting, Live, Reconnecting, NotFound, Unsupported, Login }

/// <summary>
/// One open chart: the last snapshot and the connection. Each SSE snapshot replaces the model; 35 s of silence, a drop or a 503 keeps the drawing and reconnects
/// after 1, 2, 4 … 30 s for as long as the chart is open. A 404 says not found (that chart) or not on this server (an older server, checked again every 60 s);
/// a lost sign-in stops until the window's connection changes.
/// </summary>
public sealed class LatticeChartFeed
{
    public delegate IAsyncEnumerable<LatticeSnapshot> Opener(Action onActivity, CancellationToken token);
    public LatticeSnapshot? Snapshot { get; private set; }
    public LatticeDiff? LastDiff { get; private set; }
    public LatticeConnection Connection { get; private set; } = LatticeConnection.Connecting;
    public event Action? Changed;
    private readonly Func<TimeSpan, CancellationToken, Task> delay;
    private readonly TimeSpan silence;
    public LatticeChartFeed(Func<TimeSpan, CancellationToken, Task>? delay = null, TimeSpan? silence = null) { this.delay = delay ?? Task.Delay; this.silence = silence ?? TimeSpan.FromSeconds(35); }

    public async Task RunAsync(Opener open, CancellationToken token)
    {
        var attempt = 0;
        while (!token.IsCancellationRequested)
        {
            TimeSpan wait;
            using var quiet = CancellationTokenSource.CreateLinkedTokenSource(token);
            try
            {
                quiet.CancelAfter(silence);
                await foreach (var snapshot in open(() => quiet.CancelAfter(silence), quiet.Token).WithCancellation(quiet.Token))
                {
                    LastDiff = LatticeChart.Diff(Snapshot, snapshot); Snapshot = snapshot; attempt = 0;
                    Set(LatticeConnection.Live, force: true);
                }
            }
            catch (OperationCanceledException) when (token.IsCancellationRequested) { return; }
            catch (BellApiException error) when (error.RequiresLogin) { Set(LatticeConnection.Login); return; }
            catch (BellApiException error) when (error.Status == System.Net.HttpStatusCode.NotFound)
            {
                if (error.Code == "LATTICE_CHART_NOT_FOUND") { Set(LatticeConnection.NotFound); return; }
                Set(LatticeConnection.Unsupported); wait = TimeSpan.FromSeconds(60);
                if (await Pause(wait, token)) continue; return;
            }
            catch (Exception) { Set(LatticeConnection.Reconnecting); }
            wait = TimeSpan.FromMilliseconds(LatticeChart.BackoffMs(attempt++));
            if (!await Pause(wait, token)) return;
        }
    }
    private async Task<bool> Pause(TimeSpan wait, CancellationToken token)
    {
        try { await delay(wait, token); return true; } catch (OperationCanceledException) { return false; }
    }
    private void Set(LatticeConnection next, bool force = false) { if (!force && next == Connection) return; Connection = next; Changed?.Invoke(); }
}

/// <summary>The closed trees' finished cards of one open chart (a457). Pages are kept only while 過去ログ is open: the first page when it opens, the next when the list ends, the first again when history.closed changes (Reset), nothing across opens.
/// A failed page keeps the rows, shows Failed and is asked again after 1, 2, 4 … 30 s or at once by Retry; a 404 (older server) is Unsupported and asks no more until Reset.</summary>
public sealed class LatticeHistoryFeed
{
    private readonly List<LatticeHistoryPage> pages = [];
    private readonly Func<TimeSpan, CancellationToken, Task> delay;
    private int generation;
    private TaskCompletionSource? retry;
    private (LatticeSnapshot Snapshot, int Pages, int Generation, LatticeSnapshot Result)? merged;
    public LatticeHistoryFeed(Func<TimeSpan, CancellationToken, Task>? delay = null) { this.delay = delay ?? Task.Delay; }
    public IReadOnlyList<LatticeHistoryPage> Pages => pages;
    public string? Next { get; private set; }
    /// <summary>The first page has been read (or the server has no route).</summary>
    public bool Opened { get; private set; }
    public bool Loading { get; private set; }
    public bool Failed { get; private set; }
    public bool Unsupported { get; private set; }
    /// <summary>history.closed the loaded pages were read at; null before the first page.</summary>
    public int? ClosedAtLoad => pages.Count > 0 ? pages[0].Closed : null;
    public event Action? Changed;
    public void Reset()
    {
        generation++; pages.Clear(); Next = null; Opened = Loading = Failed = Unsupported = false; merged = null;
        retry?.TrySetResult(); retry = null;
    }
    /// <summary>Asks the page that failed again at once (読み直す).</summary>
    public void Retry() => retry?.TrySetResult();
    public LatticeSnapshot With(LatticeSnapshot snapshot)
    {
        if (merged is { } cached && ReferenceEquals(cached.Snapshot, snapshot) && cached.Pages == pages.Count && cached.Generation == generation) return cached.Result;
        var result = LatticeChart.WithHistory(snapshot, pages); merged = (snapshot, pages.Count, generation, result); return result;
    }

    /// <summary>Reads the first page, or the next one when the first is read; does nothing while a read runs, at the last page or on an older server. Returns when the page is read, the server is older, or the token or Reset ends it.</summary>
    public async Task LoadAsync(Func<string?, CancellationToken, Task<LatticeHistoryPage>> fetch, CancellationToken token)
    {
        if (Loading || Unsupported || (Opened && Next is null)) return;
        var mine = generation; var attempt = 0; Loading = true;
        try
        {
            while (!token.IsCancellationRequested && mine == generation)
            {
                try
                {
                    var page = await fetch(Opened ? Next : null, token);
                    if (mine != generation) return;
                    pages.Add(page); Opened = true; Failed = false; Next = page.State is "verified" or "last_verified" ? page.Next : null;
                    return;
                }
                catch (OperationCanceledException) when (token.IsCancellationRequested) { return; }
                catch (BellApiException error) when (error.Status == System.Net.HttpStatusCode.NotFound) { if (mine == generation) { Unsupported = true; Opened = true; } return; }
                catch (Exception error)
                {
                    if (mine != generation) return;
                    // A refused cursor cannot be asked again: start from the first page; the rows already known stay until it is read.
                    if (error is BellApiException { Status: System.Net.HttpStatusCode.BadRequest }) { Opened = false; Next = null; }
                    Failed = true; Changed?.Invoke();
                    var again = retry = new TaskCompletionSource();
                    try { await Task.WhenAny(delay(TimeSpan.FromMilliseconds(LatticeChart.BackoffMs(attempt++)), token), again.Task); } catch (OperationCanceledException) when (token.IsCancellationRequested) { return; }
                }
            }
        }
        finally { if (mine == generation) { Loading = false; retry = null; Changed?.Invoke(); } }
    }
}

public static class LatticeApi
{
    /// <summary>One history page (limit 50); before = the previous page's opaque next.</summary>
    public static Task<LatticeHistoryPage> LatticeHistoryAsync(this BellApi api, string projectId, string? before, CancellationToken token = default)
        => api.GetAsync<LatticeHistoryPage>($"/api/lattice/charts/{Uri.EscapeDataString(projectId)}/history?limit=50" + (before is null ? "" : "&before=" + Uri.EscapeDataString(before)), token);
    /// <summary>The Approval Box extension's decision for a card. Anything but a well-formed 200 (404 before the extension ships, 401, 503, network, bad JSON) is null: no block, no message, no retry.</summary>
    public static async Task<LatticeDecision?> DecisionAsync(this BellApi api, string projectId, string plan, string taskId, CancellationToken token = default)
    {
        try { return LatticeChart.DecisionOf(await api.GetAsync<JsonElement>($"/api/approvals/by-task?project={Uri.EscapeDataString(projectId)}&plan={Uri.EscapeDataString(plan)}&task={Uri.EscapeDataString(taskId)}", token)); }
        catch (Exception) { return null; }
    }
    public static Task<LatticeChartList> ChartsAsync(this BellApi api, CancellationToken token = default) => api.GetAsync<LatticeChartList>("/api/lattice/charts", token);
    public static async IAsyncEnumerable<LatticeSnapshot> LatticeEventsAsync(this BellApi api, string projectId, Action onActivity, [EnumeratorCancellation] CancellationToken token = default)
    {
        await foreach (var (name, data) in api.EventStreamAsync($"/api/lattice/charts/{Uri.EscapeDataString(projectId)}/events", onActivity, token))
        {
            if (name != "snapshot") continue;
            LatticeSnapshot? snapshot;
            try { snapshot = JsonSerializer.Deserialize<LatticeSnapshot>(data, BellApi.Json); }
            catch (JsonException error) { throw new BellApiException(CoreStrings.LatticeChart_LatticeEventsAsync_1(error.Message)); }
            if (snapshot is not null) yield return snapshot;
        }
    }
}
