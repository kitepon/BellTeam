using System.Net;
using System.Net.Http;
using System.Text.Json;
using BellTeam.Core;

namespace BellTeam.Tests;

public sealed class BackgroundAgentTests
{
    [Fact]
    public async Task SettingsRoundTripKeepsRevisionAndExactFields()
    {
        var calls = 0;
        using var client = new BellApi(new("http://localhost/"), new StubHandler(async (request, token) =>
        {
            calls++;
            if (request.Method == HttpMethod.Get) return StubHandler.Json("{\"settings\":[],\"backgroundAgent\":{\"revision\":null,\"selection\":null}}");
            Assert.Equal(HttpMethod.Patch, request.Method);
            Assert.Equal("/api/settings/backgroundAgent", request.RequestUri!.AbsolutePath);
            using var body = JsonDocument.Parse(await request.Content!.ReadAsStringAsync(token));
            Assert.Equal(new[] { "expectedRevision", "harness", "model", "reasoningEffort" }, body.RootElement.EnumerateObject().Select(p => p.Name));
            Assert.Equal(JsonValueKind.Null, body.RootElement.GetProperty("expectedRevision").ValueKind);
            return StubHandler.Json("{\"backgroundAgent\":{\"revision\":\"11111111-1111-4111-8111-111111111111\",\"selection\":{\"harness\":\"codex\",\"model\":\"example\",\"reasoningEffort\":\"high\"}}}");
        }));
        var api = new BackgroundAgentApi(client);
        var before = await api.ReadAsync();
        Assert.NotNull(before); Assert.Null(before.Selection);
        var saved = await api.SaveAsync(before.Revision, new("codex", "example", "high"));
        Assert.Equal("11111111-1111-4111-8111-111111111111", saved.Revision);
        Assert.Equal("example", saved.Selection!.Model);
        Assert.Equal(2, calls);
    }

    [Fact]
    public async Task MissingFieldIsNotAnUnconfiguredRecordAndConflictKeepsCode()
    {
        using var client = new BellApi(new("http://localhost/"), new StubHandler((request, _) => Task.FromResult(request.Method == HttpMethod.Get
            ? StubHandler.Json("{\"settings\":[]}")
            : new HttpResponseMessage(HttpStatusCode.Conflict) { Content = new StringContent("{\"error\":\"BACKGROUND_AGENT_REVISION_CONFLICT\",\"message\":\"変更されています\"}", System.Text.Encoding.UTF8, "application/json") })));
        var api = new BackgroundAgentApi(client);
        Assert.Null(await api.ReadAsync());
        var error = await Assert.ThrowsAsync<BellApiException>(() => api.SaveAsync(null, new("codex", "example", "high")));
        Assert.Equal("BACKGROUND_AGENT_REVISION_CONFLICT", error.Code);
    }

    [Fact]
    public void OnlyModelSpecificEffortsAreSelectable()
    {
        var catalog = new Dictionary<string, HarnessModels> { ["codex"] = new() { Efforts = ["high"], Models = [new() { Id = "one", Efforts = ["low"] }, new() { Id = "two", Efforts = [] }] } };
        Assert.True(BackgroundAgentApi.IsAvailable(new("codex", "one", "low"), catalog));
        Assert.False(BackgroundAgentApi.IsAvailable(new("codex", "one", "high"), catalog));
        Assert.False(BackgroundAgentApi.IsAvailable(new("codex", "missing", "low"), catalog));
        Assert.True(BackgroundAgentApi.IsAvailable(new("codex", "two", ""), catalog));
    }

    [Fact]
    public async Task ApplyFailurePreservesSavedStateOnExplicitReadWithoutRetry()
    {
        var posts = 0;
        using var client = new BellApi(new("http://localhost/"), new StubHandler((request, _) =>
        {
            if (request.Method == HttpMethod.Patch)
            {
                posts++;
                return Task.FromResult(new HttpResponseMessage(HttpStatusCode.InternalServerError) { Content = new StringContent("{\"error\":\"BACKGROUND_AGENT_APPLY_FAILED\",\"message\":\"保存済み\"}", System.Text.Encoding.UTF8, "application/json") });
            }
            return Task.FromResult(StubHandler.Json("{\"settings\":[],\"backgroundAgent\":{\"revision\":\"11111111-1111-4111-8111-111111111111\",\"selection\":{\"harness\":\"codex\",\"model\":\"example\",\"reasoningEffort\":\"high\"}}}"));
        }));
        var api = new BackgroundAgentApi(client);
        var error = await Assert.ThrowsAsync<BellApiException>(() => api.SaveAsync(null, new("codex", "example", "high")));
        Assert.Equal("BACKGROUND_AGENT_APPLY_FAILED", error.Code);
        Assert.Equal("example", (await api.ReadAsync())!.Selection!.Model);
        Assert.Equal(1, posts);
    }
}
