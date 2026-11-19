using System.Net;
using BellTeam.Core;

namespace BellTeam.Linux;

// a457: the closed trees' finished cards are read only when 過去ログ opens (Core LatticeHistoryFeed, LatticeChart.WithHistory / HistoryCount).
public sealed class LatticeHistoryFeedTests
{
    private static LatticeCard Card(string id, string state = "done", int day = 1) => new() { Id = id, State = state, Title = id, DoneAt = new DateTimeOffset(2026, 11, day, 9, 0, 0, TimeSpan.FromHours(9)) };
    private static LatticeHistoryPage Page(string? next, params LatticeCard[] cards) => new() { Closed = 3, Cards = cards, Next = next };
    private static readonly Func<TimeSpan, CancellationToken, Task> NoWait = (_, _) => Task.CompletedTask;

    [Fact]
    public async Task Pages_follow_next_and_stop_at_the_last_page()
    {
        var asked = new List<string?>(); var feed = new LatticeHistoryFeed(NoWait);
        Task<LatticeHistoryPage> Fetch(string? before, CancellationToken _) { asked.Add(before); return Task.FromResult(before is null ? Page("c1", Card("a/1")) : Page(null, Card("a/2", day: 2))); }
        await feed.LoadAsync(Fetch, default); await feed.LoadAsync(Fetch, default); await feed.LoadAsync(Fetch, default);
        Assert.Equal([null, "c1"], asked); Assert.Equal(2, feed.Pages.Count); Assert.Null(feed.Next); Assert.Equal(3, feed.ClosedAtLoad);
    }

    [Fact]
    public async Task An_older_server_is_asked_once_and_then_left_alone_until_reset()
    {
        var calls = 0; var feed = new LatticeHistoryFeed(NoWait);
        Task<LatticeHistoryPage> Fetch(string? _, CancellationToken __) { calls++; throw new BellApiException("no", HttpStatusCode.NotFound); }
        await feed.LoadAsync(Fetch, default); await feed.LoadAsync(Fetch, default);
        Assert.Equal(1, calls); Assert.True(feed.Unsupported); Assert.False(feed.Failed);
        feed.Reset(); await feed.LoadAsync(Fetch, default); Assert.Equal(2, calls);
    }

    [Fact]
    public async Task A_failed_page_keeps_the_rows_and_is_asked_again_by_the_same_cursor()
    {
        var asked = new List<string?>(); var feed = new LatticeHistoryFeed(NoWait); var failures = 0; var sawFailed = false;
        feed.Changed += () => sawFailed |= feed.Failed;
        Task<LatticeHistoryPage> Fetch(string? before, CancellationToken _)
        {
            asked.Add(before);
            if (before is null) return Task.FromResult(Page("c1", Card("a/1")));
            if (failures++ < 2) throw new BellApiException("down", HttpStatusCode.ServiceUnavailable);
            return Task.FromResult(Page(null, Card("a/2")));
        }
        await feed.LoadAsync(Fetch, default); await feed.LoadAsync(Fetch, default);
        Assert.Equal([null, "c1", "c1", "c1"], asked); Assert.True(sawFailed); Assert.False(feed.Failed); Assert.Equal(2, feed.Pages.Count);
    }

    [Fact]
    public async Task A_refused_cursor_is_asked_again_from_the_first_page()
    {
        var asked = new List<string?>(); var feed = new LatticeHistoryFeed(NoWait); var refused = false;
        Task<LatticeHistoryPage> Fetch(string? before, CancellationToken _)
        {
            asked.Add(before);
            if (before is "c1" && !refused) { refused = true; throw new BellApiException("bad", HttpStatusCode.BadRequest); }
            return Task.FromResult(before is null ? Page("c1", Card("a/1")) : Page(null, Card("a/2")));
        }
        await feed.LoadAsync(Fetch, default); await feed.LoadAsync(Fetch, default);
        Assert.Equal([null, "c1", null], asked);
    }

    [Fact]
    public async Task Retry_asks_at_once_and_a_reset_drops_the_pages_and_the_reading()
    {
        var gate = new TaskCompletionSource(); var feed = new LatticeHistoryFeed((_, token) => gate.Task.WaitAsync(token)); var calls = 0;
        Task<LatticeHistoryPage> Fetch(string? _, CancellationToken __) => ++calls == 1 ? throw new BellApiException("down", HttpStatusCode.ServiceUnavailable) : Task.FromResult(Page(null, Card("a/1")));
        var loading = feed.LoadAsync(Fetch, default);
        Assert.True(feed.Failed); feed.Retry(); await loading;
        Assert.Equal(2, calls); Assert.Single(feed.Pages);
        feed.Reset(); Assert.Empty(feed.Pages); Assert.False(feed.Opened);
    }

    [Fact]
    public void The_count_and_the_merge_follow_the_contract()
    {
        var snapshot = new LatticeSnapshot { ProjectId = "p", Cards = [Card("a/1"), Card("a/3", "in-progress"), Card("a/4", "retired")], History = new(2), Members = [new("bot-1", "A", null, null)] };
        Assert.Equal(4, LatticeChart.HistoryCount(snapshot));
        Assert.Equal(2, LatticeChart.HistoryCount(snapshot with { History = null }));
        var page = new LatticeHistoryPage { Closed = 2, Cards = [Card("a/1", day: 5), Card("b/1", day: 7), Card("b/2", day: 6)], Members = [new("bot-1", "Page A", null, null), new("bot-2", "B", null, null)] };
        var merged = LatticeChart.WithHistory(snapshot, [page]);
        // The snapshot's card wins over the same id; the page's members are added, a known one keeps the snapshot's entry.
        Assert.Equal(5, merged.Cards.Length); Assert.Equal(["bot-1", "bot-2"], merged.Members.Select(member => member.BotId)); Assert.Equal("A", merged.Members[0].Name);
        Assert.Equal(["b/1", "b/2", "a/1", "a/4"], LatticeChart.History(merged, DateTimeOffset.UtcNow).Groups.SelectMany(group => group.Rows).Select(row => row.Id));
        Assert.Same(snapshot, LatticeChart.WithHistory(snapshot, []));
    }
}
