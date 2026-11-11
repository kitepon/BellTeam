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
}
public sealed record LatticeCounts(int Total, int Done, int Working, int Waiting, int Blocked);
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
    public LatticePhase[] Phases { get; init; } = [];
    public LatticeEdge[] Edges { get; init; } = [];
    public LatticeWait[] Waits { get; init; } = [];
}
public sealed record LatticeMember(string BotId, string Name, string? Color, string? AvatarVersion);
public sealed record LatticeCard
{
    public required string Id { get; init; }
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
    /// <summary>Finished and none of its next cards is still unstarted: left out of the tree and lanes, kept for 詳細, links, 過去ログ and counts.</summary>
    public bool Archived { get; init; }
}
public sealed record LatticePhase(string Id, string? Title);
public sealed record LatticeEdge(string From, string To, bool Waiting);
public sealed record LatticeWait(string? Waiter, string WaitingCard, string ForCard, string? Producer, string? ProducerState, DateTimeOffset? Since);

/// <summary>A member as drawn: the roster entry, or 名簿にないメンバー (Known false, drawn as 「?」 and never opened as a chat).
/// Authored: the plan's written lane text with no member behind it (BotId "", drawn with its initial, never a chat, not in the member rail).</summary>
public sealed record LatticePerson(string BotId, string Name, string? Color, string AvatarVersion, bool Known, bool Authored = false);
public sealed record LatticeStateInfo(string Badge, string Tone);
public sealed record LatticeLane(string? BotId, LatticePerson? Member, double Y, double Height);
public sealed record LatticePlaced(double X, double Y, double Width, double Height, int Depth, int Lane);
public sealed record LatticeLayout(IReadOnlyList<LatticeLane> Lanes, IReadOnlyDictionary<string, LatticePlaced> Cards, IReadOnlyList<string> Order, double Width, double Height);
public sealed record LatticeWaitRow(string Key, LatticePerson? Waiter, LatticePerson? Producer, string Title, string StateText, string ForCard, string WaitingCard, string Headline, string OwnerText, string Length, bool Emphasized, LatticeStateInfo Info, bool CanChat, string Label);
public sealed record LatticeRailItem(string BotId, LatticePerson Member, bool Working, bool Blocked, int Waiting);
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
public sealed record LatticeListItem(string ProjectId, string Name, bool Coordinator, int Done, int Total, int Waiting, IReadOnlyList<LatticePerson> Members, double Fraction, string Updated, string Label);

public static class LatticeChart
{
    public const string UnknownMember = "名簿にないメンバー", Unassigned = "担当なし";
    public const string Reconnecting = "工程表に再接続しています…", ListEmpty = "工程表はまだありません。メンバーがLatticeで工程をつくると、ここに並びます。",
        NewChart = "工程表はメンバーがLatticeでつくります。権限も参加登録もなく、誰でも開けます。", OldServer = "このサーバーではまだ工程表を使えません。", OldServerNext = "サーバーが更新されると使えるようになります。",
        NotFound = "この工程表は見つかりません。", Unavailable = "この工程表はまだ読めません。", UnavailableNext = "記録が整うと自動で表示します。", NoCards = "この工程表にはまだ工程がありません。",
        LoginRequired = "ログインが必要です。ログインし直すと、自動で表示します。";

    public static LatticeStateInfo StateInfo(string? state) => state switch
    {
        "ready" => new("着手可", "ready"), "in-progress" => new("作業中", "working"), "blocked" => new("止まり", "blocked"),
        "done" => new("完了", "done"), "retired" => new("取り下げ", "retired"), _ => new("未着手", "pending")
    };
    public static bool Finished(string? state) => state is "done" or "retired";

    /// <summary>The chart's name everywhere it is named: its name, else 「作った人の工程表」 from the app's roster, else 名前のない工程表. The project id never appears.</summary>
    public static string ChartName(string? name, string? createdBy, Func<string, string?> rosterName)
        => name is { Length: > 0 } ? name : createdBy is { Length: > 0 } && rosterName(createdBy) is { Length: > 0 } creator ? creator + "の工程表" : "名前のない工程表";

    // Reconnect wait: 1, 2, 4 … 30 s (each ±20%), forever while open.
    public static int BackoffMs(int attempt, Func<double>? random = null)
        => (int)Math.Min(30000, Math.Round(Math.Min(30000, 1000 * Math.Pow(2, Math.Max(0, attempt))) * (0.8 + 0.4 * (random ?? Random.Shared.NextDouble)())));

    private static readonly TimeZoneInfo Jst = TimeZoneInfo.CreateCustomTimeZone("JST", TimeSpan.FromHours(9), "JST", "JST");
    public static string FormatJst(DateTimeOffset? value) => value is { } at ? TimeZoneInfo.ConvertTime(at, Jst).ToString("M月d日 HH:mm", CultureInfo.InvariantCulture) : "";
    public static string SinceText(DateTimeOffset? value, DateTimeOffset now)
    {
        var minutes = value is { } at ? Math.Max(0, (int)Math.Floor((now - at).TotalMinutes)) : 0;
        if (minutes < 1) return "1分未満";
        if (minutes < 60) return $"{minutes}分";
        if (minutes < 1440) return minutes % 60 != 0 ? $"{minutes / 60}時間{minutes % 60}分" : $"{minutes / 60}時間";
        return $"{minutes / 1440}日";
    }

    public static Func<string?, LatticePerson?> Lookup(LatticeSnapshot snapshot)
    {
        var roster = snapshot.Members.GroupBy(member => member.BotId).ToDictionary(group => group.Key, group => group.First());
        return botId => botId is not { Length: > 0 } ? null : roster.TryGetValue(botId, out var member)
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
    public const double CardWidth = 168, CardHeight = 108, CardDoneHeight = 50, ColumnWidth = 236, LabelWidth = 132, Top = 14, LaneMin = 116, LaneGap = 10, LanePad = 10, StackGap = 10;
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
    public const double TreeRow = 40, TreeBoxHeight = 32, TreeGap = 36, TreeTop = 16, TreeLeft = 16, TreeRootWidth = 168, TreePhaseWidth = 196, TreeCardWidth = 300;
    public const string UnnamedPhase = "名前のないまとまり";
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
        var nodes = drafts.Values.Where(draft => seen.Contains(draft.Key)).Select(draft =>
        {
            // done/total count every card, archived included, like the ring: the chart all of them, a phase the cards of that phase.
            var inside = draft.Kind switch { "card" => [], "root" => all, _ => all.Where(card => "phase:" + card.Phase == draft.Key).ToList() };
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
            var heading = day is not { } date ? "日時の分からない工程" : date == today ? "今日" : date == today.AddDays(-1) ? "昨日" : date.ToString("M月d日", CultureInfo.InvariantCulture);
            if (groups.Count == 0 || groups[^1].Heading != heading) groups.Add((heading, []));
            var owner = ownerOf(card); var info = StateInfo(card.State); var time = card.DoneAt is { } done ? Local(done).ToString("HH:mm", CultureInfo.InvariantCulture) : "";
            groups[^1].Rows.Add(new(card.Id, card, owner, info, time, $"{Title(card)}、{info.Badge}{(time.Length > 0 ? $"、{heading} {time}" : "")}、{NameOf(owner)}"));
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
    public const double FlowSpawnMs = 600, FlowTravelMs = 1400;
    /// <summary>Waiting edge particles: one every 600 ms, 1.4 s toward the waiter. The progress (0..1) of each particle in flight.</summary>
    public static IEnumerable<double> FlowPositions(double nowMs)
    {
        for (var n = Math.Floor(nowMs / FlowSpawnMs); n * FlowSpawnMs > nowMs - FlowTravelMs; n--) yield return (nowMs - n * FlowSpawnMs) / FlowTravelMs;
    }
    public static double ParticleOpacity(double t) => Math.Max(0, Math.Min(1, Math.Min(t / 0.07, (1 - t) / 0.23)));

    public static LatticeCounts Counts(LatticeSnapshot snapshot)
    {
        var waiting = snapshot.Edges.Where(edge => edge.Waiting).Select(edge => edge.To).ToHashSet();
        return new(snapshot.Cards.Length, snapshot.Cards.Count(card => Finished(card.State)), snapshot.Cards.Count(card => card.State == "in-progress"),
            snapshot.Cards.Count(card => waiting.Contains(card.Id)), snapshot.Cards.Count(card => card.State == "blocked"));
    }

    /// <summary>作業中 N分 / 止まり: 理由 / 未着手: 担当 ◯◯ / 担当なし.</summary>
    public static string ProducerStateText(LatticeCard? card, string? state, LatticePerson? member, DateTimeOffset now)
    {
        var info = StateInfo(state);
        return state switch
        {
            "in-progress" => $"{info.Badge} {SinceText(card?.StartedAt, now)}",
            "blocked" => card?.BlockedReason is { Length: > 0 } reason ? $"{info.Badge}: {reason}" : info.Badge,
            "pending" or "ready" => member is not null ? $"{info.Badge}: 担当 {member.Name}" : Unassigned,
            _ => info.Badge
        };
    }
    public static string CardLabel(LatticeCard card, LatticePerson? member) => $"{Title(card)}、{StateInfo(card.State).Badge}、つくっている {NameOf(member)}";
    public static string Title(LatticeCard? card) => card?.Title is { Length: > 0 } title ? title : "名前のない工程";
    /// <summary>The line under a card: the reason when blocked, the producer when not started, who is making it while in progress.</summary>
    public static string CardNote(LatticeCard card, LatticePerson? member) => card.State switch
    {
        "blocked" => card.BlockedReason ?? "",
        "pending" or "ready" => member is not null ? $"担当 {member.Name}" : Unassigned,
        "in-progress" => member is not null ? $"{member.Name}がつくっています" : "",
        _ => ""
    };

    public static IReadOnlyList<LatticeWaitRow> WaitRows(LatticeSnapshot snapshot, DateTimeOffset now)
    {
        var lookup = Lookup(snapshot); var ownerOf = Owner(snapshot); var cards = snapshot.Cards.GroupBy(card => card.Id).ToDictionary(group => group.Key, group => group.First());
        return snapshot.Waits.OrderBy(wait => wait.Since ?? DateTimeOffset.MaxValue).Select(wait =>
        {
            cards.TryGetValue(wait.ForCard, out var awaited); cards.TryGetValue(wait.WaitingCard, out var waiting);
            var waiter = wait.Waiter is { Length: > 0 } ? lookup(wait.Waiter) : ownerOf(waiting); var producer = wait.Producer is { Length: > 0 } ? lookup(wait.Producer) : ownerOf(awaited);
            var state = wait.ProducerState ?? awaited?.State; var title = Title(awaited); var stateText = ProducerStateText(awaited, state, producer, now);
            // The row reads on its own (screen-spec 待ちの流れ): the waiting card and its owner first, then what it waits for and who makes that.
            var waitingTitle = Title(waiting); var ownerText = waiter is null ? Unassigned : $"担当 {waiter.Name}";
            return new LatticeWaitRow($"{wait.WaitingCard}>{wait.ForCard}", waiter, producer, title, stateText, wait.ForCard, wait.WaitingCard, waitingTitle, ownerText,
                SinceText(wait.Since, now), state == "blocked", StateInfo(state), producer?.Known == true, $"「{waitingTitle}」（{ownerText}）は、「{title}」が終わるのを待っています。つくっているのは{NameOf(producer)}、{stateText}");
        }).ToList();
    }
    /// <summary>The chip on a waiting edge: 「◯◯が待っています」, the waiter being the owner of the later card; 次の工程が待っています when it has no owner.</summary>
    public static string EdgeChip(LatticeSnapshot snapshot, LatticeEdge edge)
        => Owner(snapshot)(snapshot.Cards.FirstOrDefault(card => card.Id == edge.To)) is { } owner ? $"{owner.Name}が待っています" : "次の工程が待っています";

    public static IReadOnlyList<LatticeRailItem> Rail(LatticeSnapshot snapshot, LatticeLayout layout)
        => layout.Lanes.Where(lane => lane.BotId is not null).Select(lane => new LatticeRailItem(lane.BotId!, lane.Member!,
            snapshot.Cards.Any(card => card.Producer == lane.BotId && card.State == "in-progress"), snapshot.Cards.Any(card => card.Producer == lane.BotId && card.State == "blocked"),
            snapshot.Waits.Count(wait => wait.Waiter == lane.BotId))).ToList();

    /// <summary>The member's cards and the waits they are part of; everything else dims.</summary>
    public static (HashSet<string> Cards, HashSet<string> Waits) Highlight(LatticeSnapshot snapshot, string botId)
        => (snapshot.Cards.Where(card => card.Producer == botId).Select(card => card.Id).ToHashSet(),
            snapshot.Waits.Where(wait => wait.Waiter == botId || wait.Producer == botId).Select(wait => $"{wait.WaitingCard}>{wait.ForCard}").ToHashSet());

    public static LatticeDetail? Detail(LatticeSnapshot snapshot, string cardId, DateTimeOffset now)
    {
        var cards = snapshot.Cards.GroupBy(card => card.Id).ToDictionary(group => group.Key, group => group.First());
        if (!cards.TryGetValue(cardId, out var card)) return null;
        var ownerOf = Owner(snapshot);
        LatticeLink? Link(string id) => cards.TryGetValue(id, out var other) ? new(id, Title(other), other.State, ownerOf(other), ProducerStateText(other, other.State, ownerOf(other), now)) : null;
        return new(card, ownerOf(card), StateInfo(card.State), ProducerStateText(card, card.State, ownerOf(card), now),
            snapshot.Edges.Where(edge => edge.To == cardId).Select(edge => Link(edge.From)).OfType<LatticeLink>().ToList(),
            snapshot.Edges.Where(edge => edge.From == cardId).Select(edge => Link(edge.To)).OfType<LatticeLink>().ToList(),
            card.StartedAt is { } started ? $"着手 {FormatJst(started)} JST" : "まだ着手されていません");
    }

    public static LatticeBanner? Banner(LatticeSnapshot snapshot) => snapshot.State switch
    {
        "unverified" => new("amber", "工程表の記録に食い違いがあります。読める分だけ表示しています。", "直り次第、自動で最新に戻ります。", false),
        "last_verified" => new("grey", $"いまの記録が読めないため、最後に確認できた状態{(snapshot.VerifiedAt is { } at ? $"（{FormatJst(at)} JST）" : "")}を表示しています。", "読めるようになると自動で切り替わります。", true),
        _ => null
    };
    public static IReadOnlyList<string> DegradedPills(LatticeSnapshot snapshot)
        => snapshot.Degraded.Select(key => key switch { "lattice-read" => "最新の記録を読み直しています…", "members" => "メンバー情報を読み直しています…", _ => null }).OfType<string>().Distinct().ToList();

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

    /// <summary>List cards in the server's order (coordinator charts first). Active members come from the app's roster; one not in it is 「?」.</summary>
    public static IReadOnlyList<LatticeListItem> ListItems(LatticeChartList list, Func<string, LatticePerson?> roster)
        => list.Charts.Select(chart =>
        {
            var members = chart.ActiveMembers.Take(4).Select(id => roster(id) ?? new LatticePerson(id, UnknownMember, null, "", false)).ToList();
            var counts = chart.Counts ?? new(0, 0, 0, 0, 0);
            var name = ChartName(chart.Name, chart.CreatedBy, id => roster(id)?.Name);
            return new LatticeListItem(chart.ProjectId, name, chart.Coordinator, counts.Done, counts.Total, counts.Waiting, members,
                counts.Total > 0 ? Math.Min(1, (double)counts.Done / counts.Total) : 0, chart.UpdatedAt is { } at ? $"更新 {FormatJst(at)}" : "",
                $"{name}{(chart.Coordinator ? "、統括の工程表" : "")}、完了 {counts.Done}/{counts.Total}、待ち {counts.Waiting}{(members.Count > 0 ? "、動いているのは" + string.Join("、", members.Select(member => member.Name)) : "")}");
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

public static class LatticeApi
{
    public static Task<LatticeChartList> ChartsAsync(this BellApi api, CancellationToken token = default) => api.GetAsync<LatticeChartList>("/api/lattice/charts", token);
    public static async IAsyncEnumerable<LatticeSnapshot> LatticeEventsAsync(this BellApi api, string projectId, Action onActivity, [EnumeratorCancellation] CancellationToken token = default)
    {
        await foreach (var (name, data) in api.EventStreamAsync($"/api/lattice/charts/{Uri.EscapeDataString(projectId)}/events", onActivity, token))
        {
            if (name != "snapshot") continue;
            LatticeSnapshot? snapshot;
            try { snapshot = JsonSerializer.Deserialize<LatticeSnapshot>(data, BellApi.Json); }
            catch (JsonException error) { throw new BellApiException("工程表のデータを読み取れませんでした。" + error.Message); }
            if (snapshot is not null) yield return snapshot;
        }
    }
}
