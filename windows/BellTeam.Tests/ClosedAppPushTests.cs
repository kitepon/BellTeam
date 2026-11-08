using System.IO;
using System.Net.Http;
using System.Text.Json.Nodes;
using BellTeam.App;
using BellTeam.Core;

namespace BellTeam.Tests;
public sealed class ClosedAppPushTests
{
    [Theory]
    [InlineData("bellteam-update:?server=http%3A%2F%2F192.168.1.2%3A18891", "http://192.168.1.2:18891/")]
    [InlineData("bellteam-update:?server=https%3A%2F%2Fbell.example.test%2F", "https://bell.example.test/")]
    [InlineData("BELLTEAM-UPDATE:?server=https%3A%2F%2Fbell.example.test", "https://bell.example.test/")]
    [InlineData("bellteam-update:?server=http%3A%2F%2Fexample.com", null)]
    [InlineData("bellteam-update:?server=https%3A%2F%2Fbell.example.test%2Fpath", null)]
    [InlineData("bellteam-update:?server=https%3A%2F%2Fa.test&server=https%3A%2F%2Fb.test", null)]
    [InlineData("bellteam-update:?server=https%3A%2F%2Fa.test&kind=update", null)]
    [InlineData("bellteam-update:server=https%3A%2F%2Fa.test", null)]
    [InlineData("https://bell.example.test/", null)]
    public void UpdateLaunchReadsOnlyTheServerOrigin(string argument, string? expected) => Assert.Equal(expected, UpdateLaunch.Server(argument));

    [Fact]
    public async Task RegistersOnceReplacesWithPreviousAndUnregistersOnOff()
    {
        var directory = Path.Combine(Path.GetTempPath(), "BellTeam-push-" + Guid.NewGuid()); var store = new SettingsStore(directory);
        var requests = new List<(string Path, JsonObject Body)>();
        using var api = new BellApi(new Uri("http://192.168.1.2:18891/"), new StubHandler(async (request, token) =>
        {
            var body = JsonNode.Parse(await request.Content!.ReadAsStringAsync(token))!.AsObject(); requests.Add((request.RequestUri!.AbsolutePath, body));
            return StubHandler.Json(request.RequestUri.AbsolutePath.EndsWith("/devices") ? """{"registered":true}""" : """{"registered":false}""");
        }));
        try
        {
            store.Save(new() { ServerUrl = "http://192.168.1.2:18891/", NotificationsEnabled = true });
            var source = new FakeChannel("https://wns2-pn1p.notify.windows.com/?token=one"); var push = new ClosedAppPush(source, store); const string server = "http://192.168.1.2:18891/";

            await push.SyncAsync(api, server, true);
            var first = Assert.Single(requests); Assert.Equal("/api/notifications/windows/devices", first.Path);
            Assert.Equal("http://192.168.1.2:18891", (string?)first.Body["server"]); Assert.Equal(source.Uri, (string?)first.Body["channelUri"]); Assert.False(first.Body.ContainsKey("previousChannelUri"));
            Assert.Equal(source.Expires.ToString("O"), (string?)first.Body["expiresAt"]); Assert.Equal(3, first.Body.Count);

            await push.SyncAsync(api, server, true); Assert.Single(requests);

            source.Expires = source.Expires.AddDays(1); await push.SyncAsync(api, server, true);
            Assert.Equal(2, requests.Count); Assert.False(requests[1].Body.ContainsKey("previousChannelUri")); Assert.Equal(source.Expires.ToString("O"), (string?)requests[1].Body["expiresAt"]);

            source.Uri = "https://wns2-pn1p.notify.windows.com/?token=two"; await push.SyncAsync(api, server, true);
            Assert.Equal(3, requests.Count); Assert.Equal("https://wns2-pn1p.notify.windows.com/?token=one", (string?)requests[2].Body["previousChannelUri"]);
            Assert.Equal(new PushChannelRegistration(server, source.Uri, source.Expires), store.Load().PushChannel);

            await push.SyncAsync(api, server, false);
            Assert.Equal(4, requests.Count); Assert.Equal("/api/notifications/windows/unregister", requests[3].Path); Assert.Equal(source.Uri, (string?)requests[3].Body["channelUri"]); Assert.Single(requests[3].Body);
            Assert.Null(store.Load().PushChannel); Assert.Equal(1, source.Closes); Assert.True(store.Load().NotificationsEnabled);

            await push.SyncAsync(api, server, false); Assert.Equal(4, requests.Count);
        }
        finally { if (Directory.Exists(directory)) Directory.Delete(directory, true); }
    }

    [Fact]
    public async Task FailedRegistrationKeepsThePreviousRecordAndOtherServerIsNotSentPrevious()
    {
        var directory = Path.Combine(Path.GetTempPath(), "BellTeam-push-" + Guid.NewGuid()); var store = new SettingsStore(directory);
        var fail = true; var bodies = new List<JsonObject>();
        using var api = new BellApi(new Uri("https://new.example.test/"), new StubHandler(async (request, token) =>
        {
            bodies.Add(JsonNode.Parse(await request.Content!.ReadAsStringAsync(token))!.AsObject());
            return fail ? new HttpResponseMessage(System.Net.HttpStatusCode.ServiceUnavailable) : StubHandler.Json("""{"registered":true}""");
        }));
        try
        {
            var old = new PushChannelRegistration("https://old.example.test/", "https://wns2-pn1p.notify.windows.com/?token=old", DateTimeOffset.UnixEpoch); store.Save(new() { PushChannel = old });
            var push = new ClosedAppPush(new FakeChannel("https://wns2-pn1p.notify.windows.com/?token=new"), store);
            await Assert.ThrowsAnyAsync<Exception>(() => push.SyncAsync(api, "https://new.example.test/", true)); Assert.Equal(old, store.Load().PushChannel);
            fail = false; await push.SyncAsync(api, "https://new.example.test/", true);
            Assert.All(bodies, body => Assert.False(body.ContainsKey("previousChannelUri"))); Assert.Equal("https://new.example.test/", store.Load().PushChannel!.Server);
        }
        finally { if (Directory.Exists(directory)) Directory.Delete(directory, true); }
    }

    private sealed class FakeChannel(string uri) : IPushChannelSource
    {
        public string Uri { get; set; } = uri;
        public DateTimeOffset Expires { get; set; } = new(2026, 12, 8, 17, 38, 37, TimeSpan.FromHours(9));
        public int Closes { get; private set; }
        public Task<PushChannelInfo> OpenAsync() => Task.FromResult(new PushChannelInfo(Uri, Expires));
        public void Close() => Closes++;
    }
}
