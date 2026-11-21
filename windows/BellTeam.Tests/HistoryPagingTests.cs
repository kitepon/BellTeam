using System.Net.Http;
using BellTeam.App;
using BellTeam.Core;

namespace BellTeam.Tests;

// machine-stream.md "History pages of a long stream" (a471-scrollback): page sizes, before_at, one older request at a time, and the prefetch rule.
public sealed class HistoryPagingTests
{
    [Fact]
    public void PrefetchReadsWhileLessThanThreeScreens150RowsOr2SecondsOfSpeedIsAboveTheView()
    {
        // 1000 px view, 200 rows in 20000 px (100 px a row): the floor is max(3000, 15000, 2 * speed).
        Assert.True(HistoryPaging.NeedsOlderPage(14999, 1000, 20000, 200, 0)); Assert.False(HistoryPaging.NeedsOlderPage(15000, 1000, 20000, 200, 0));
        // short rows (10 px, so 150 rows are 1500 px): 3 screens win; a fast scroll (10000 px/s) wants 20000 px.
        Assert.True(HistoryPaging.NeedsOlderPage(2999, 1000, 150, 15, 0)); Assert.False(HistoryPaging.NeedsOlderPage(3000, 1000, 150, 15, 0));
        Assert.True(HistoryPaging.NeedsOlderPage(19999, 1000, 20000, 200, 10000)); Assert.False(HistoryPaging.NeedsOlderPage(20000, 1000, 20000, 200, 10000));
        Assert.True(HistoryPaging.NeedsOlderPage(0, 1000, 0, 0, 0)); // nothing loaded yet
    }

    [Fact]
    public void BeforeAtIsTheRowTimeInUtcMilliseconds() => Assert.Equal("2026-11-21T01:30:15.250Z", HistoryPaging.BeforeAt(DateTimeOffset.Parse("2026-11-21T10:30:15.250+09:00")));

    [Fact]
    public void TheFirstPageAsks100AndAnOlderPageAsks500WithBeforeAtAndOnlyOneRunsAtATime()
    {
        Exception? failure = null;
        var thread = new Thread(() =>
        {
            try
            {
                var requests = new List<string>(); var gate = new TaskCompletionSource();
                using var workspace = new Workspace(origin => new BellApi(origin, new StubHandler(async (request, _) =>
                {
                    var path = request.RequestUri!.AbsolutePath;
                    if (path == "/api/bots/one/messages")
                    {
                        requests.Add(request.RequestUri.Query);
                        if (request.RequestUri.Query.Contains("before=")) { await gate.Task; return StubHandler.Json("""{"items":[{"id":"m1","kind":"message","direction":"incoming","at":"2026-11-21T00:00:00.000Z","message":"older"}],"has_more":false}"""); }
                        return StubHandler.Json("""{"items":[{"id":"m2","kind":"message","direction":"incoming","at":"2026-11-21T01:00:00.125Z","message":"newest"}],"has_more":true}""");
                    }
                    return StubHandler.Json(path switch
                    {
                        "/api/session" => "{\"authenticated\":true,\"authMode\":\"local\"}", "/api/bots" => """{"bots":[{"id":"one","name":"ユキ","displayName":"ユキ"}]}""", "/api/owner" => ApiTests.Owner, "/api/rooms" => """{"rooms":[]}""", "/api/queue" => ApiTests.EmptyQueue, _ => ApiTests.Page
                    });
                })));
                workspace.ConnectAsync("http://localhost", listen: false).GetAwaiter().GetResult(); workspace.SelectAsync(workspace.Entries.Single()).GetAwaiter().GetResult();
                Assert.Equal("?limit=100", requests[0]);
                var first = workspace.LoadOlderAsync(); var second = workspace.LoadOlderAsync(); // the second waits for the first
                gate.SetResult(); Task.WaitAll(first, second);
                Assert.Single(requests, query => query.Contains("before="));
                Assert.Equal("?limit=500&before=m2&before_at=2026-11-21T01:00:00.125Z", requests.Single(query => query.Contains("before=")));
                Assert.Equal(["m1", "m2"], workspace.Messages.Select(item => item.Message.Id));
            }
            catch (Exception error) { failure = error; }
        });
        thread.SetApartmentState(ApartmentState.STA); thread.Start(); thread.Join(); if (failure is not null) System.Runtime.ExceptionServices.ExceptionDispatchInfo.Capture(failure).Throw();
    }

    [Fact]
    public void AnOlderReadAfterDisposeEndsAtOnce()
    {
        // The render modes dispose the workspace while a scroll prefetch is still queued on the window: it must end, not throw on the disposed selection.
        Exception? failure = null;
        var thread = new Thread(() =>
        {
            try
            {
                var workspace = new Workspace(origin => new BellApi(origin, new StubHandler((request, _) => Task.FromResult(StubHandler.Json(request.RequestUri!.AbsolutePath switch
                {
                    "/api/bots/one/messages" => """{"items":[{"id":"m2","kind":"message","direction":"incoming","at":"2026-11-21T01:00:00.125Z","message":"newest"}],"has_more":true}""",
                    "/api/session" => "{\"authenticated\":true,\"authMode\":\"local\"}", "/api/bots" => """{"bots":[{"id":"one","name":"ユキ","displayName":"ユキ"}]}""", "/api/owner" => ApiTests.Owner, "/api/rooms" => """{"rooms":[]}""", "/api/queue" => ApiTests.EmptyQueue, _ => ApiTests.Page
                })))));
                workspace.ConnectAsync("http://localhost", listen: false).GetAwaiter().GetResult(); workspace.SelectAsync(workspace.Entries.Single()).GetAwaiter().GetResult();
                workspace.Dispose();
                workspace.LoadOlderAsync().GetAwaiter().GetResult();
            }
            catch (Exception error) { failure = error; }
        });
        thread.SetApartmentState(ApartmentState.STA); thread.Start(); thread.Join(); if (failure is not null) System.Runtime.ExceptionServices.ExceptionDispatchInfo.Capture(failure).Throw();
    }
}
