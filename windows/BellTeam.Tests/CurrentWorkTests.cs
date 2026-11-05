using System.Text.Json;
using BellTeam.Core;

namespace BellTeam.Tests;

public sealed class CurrentWorkTests
{
    private static JsonElement Json(string source) => JsonDocument.Parse(source).RootElement.Clone();

    [Theory]
    [InlineData("working")]
    [InlineData("idle")]
    [InlineData("unknown")]
    public void BackgroundSummaryDoesNotChangeObservedState(string state)
    {
        var observed = state == "unknown" ? "null" : "\"2026-11-04T23:00:00Z\"";
        var work = CurrentWork.Read(Json($$"""{"state":"{{state}}","summary":"設定を確認しています","summaryStatus":"current","summaryUpdatedAt":"2026-11-04T23:00:00Z","observedAt":{{observed}},"source":"background_agent"}"""));
        Assert.NotNull(work); Assert.Equal(state, work.State); Assert.Equal("設定を確認しています", work.Summary);
    }

    [Theory]
    [InlineData("working", "missing", "作業中・要約未取得")]
    [InlineData("idle", "missing", "待機中")]
    [InlineData("unknown", "missing", "仕事状況を未取得")]
    [InlineData("working", "stale", "作業中・要約期限切れ")]
    [InlineData("idle", "stale", "待機中・要約期限切れ")]
    [InlineData("unknown", "stale", "実行状態未取得・要約期限切れ")]
    public void MissingAndStaleHaveFixedLabels(string state, string status, string expected)
    {
        var observed = state == "unknown" ? "null" : "\"2026-11-04T23:00:00Z\"";
        var updated = status == "missing" ? "null" : "\"2026-11-04T23:00:00Z\"";
        var source = status == "missing" ? "null" : "\"background_agent\"";
        var value = Json($$"""{"state":"{{state}}","summary":null,"summaryStatus":"{{status}}","summaryUpdatedAt":{{updated}},"observedAt":{{observed}},"source":{{source}}}""");
        Assert.Equal(expected, CurrentWorkText.Bot(value));
    }

    [Fact]
    public void InvalidAndUnknownSourcesNeverExposeSummary()
    {
        const string value = "{\"state\":\"unknown\",\"summary\":\"秘密\",\"summaryStatus\":\"current\",\"summaryUpdatedAt\":\"2026-11-04T23:00:00Z\",\"observedAt\":null,\"source\":\"other\"}";
        Assert.Null(CurrentWork.Read(Json(value)));
        Assert.Null(CurrentWork.Read(Json(value.Replace("other", "self_reported"))));
        Assert.Null(CurrentWork.Read(Json(value.Replace("other", "background_agent").Replace("\"source\":", "\"extra\":1,\"source\":"))));
        Assert.Equal("仕事状況を未取得", CurrentWorkText.Bot(Json(value)));
    }

    [Fact]
    public void RoomShowsTwoDistinctMemberSummariesAndCountsOtherParticipants()
    {
        const string unknown = "{\"state\":\"unknown\",\"summary\":\"設定を確認中\",\"summaryStatus\":\"current\",\"summaryUpdatedAt\":\"2026-11-04T23:00:00Z\",\"observedAt\":null,\"source\":\"background_agent\"}";
        const string idle = "{\"state\":\"idle\",\"summary\":\"接続を整理中\",\"summaryStatus\":\"current\",\"summaryUpdatedAt\":\"2026-11-04T23:00:00Z\",\"observedAt\":\"2026-11-04T23:00:01Z\",\"source\":\"background_agent\"}";
        var room = new Room { Id = "r", Name = "室", MemberIds = ["a", "b", "c"], CurrentWork = Json($$"""{"scope":"participants","members":[{"botId":"a","currentWork":{{unknown}}},{"botId":"a","currentWork":{{unknown}}},{"botId":"b","currentWork":{{idle}}},{"botId":"outside","currentWork":{{unknown}}}]}""") };
        Bot[] bots = [new() { Id = "a", Name = "A", DisplayName = "A" }, new() { Id = "b", Name = "B", DisplayName = "B" }, new() { Id = "c", Name = "C", DisplayName = "C" }];
        var result = CurrentWorkText.Room(room, bots);
        Assert.Contains("A: 設定を確認中（実行状態未取得）", result);
        Assert.Contains("B: 接続を整理中（待機中）", result);
        Assert.EndsWith("ほか1人", result);
        Assert.Equal("仕事状況を未取得", CurrentWorkText.Bot(default));
    }
}
