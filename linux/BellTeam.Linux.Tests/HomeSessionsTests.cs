using BellTeam.Linux;
using Xunit;

namespace BellTeam.Linux.Tests;

public sealed class HomeSessionsTests
{
    private static HomeSessionRow Row(string kind = "account", string? appKind = "android", string? passId = "p1", bool current = false) => new() { Id = "s1", Kind = kind, AppKind = appKind, PassId = passId, Current = current };

    [Theory]
    [InlineData("account", "apple", "iPhone・iPad・Mac")]
    [InlineData("account", "windows", "Windows")]
    [InlineData("account", "linux", "Linux")]
    [InlineData("account", "android", "Android")]
    [InlineData("console", null, "サーバーのコンソール")]
    [InlineData("account", "unknown-kind", "アプリ")]
    public void TheDeviceIsNamedByTheKindTheAppSent(string kind, string? appKind, string expected) => Assert.Equal(expected, HomeSessionWords.Device(Row(kind, appKind)));

    [Theory]
    [InlineData(1, "この端末だけが入っています")]
    [InlineData(2, "2台が入っています")]
    [InlineData(5, "5台が入っています")]
    public void TheSummaryCountsEveryRowIncludingThisDevice(int count, string expected) => Assert.Equal(expected, HomeSessionWords.Summary(count));

    [Fact]
    public void EveryAppKindHasItsIconAndAConsoleHasNone()
    {
        foreach (var kind in new[] { "apple", "linux", "windows", "android", "web" }) Assert.False(string.IsNullOrEmpty(HomeSessionIcons.Of(kind)), kind);
        Assert.NotEqual(HomeSessionIcons.Linux, HomeSessionIcons.Android);
        Assert.Null(HomeSessionIcons.Of(null));
        Assert.Null(HomeSessionIcons.Of("unknown-kind"));
    }

    [Fact]
    public void OnlyAStoreDeviceShutsOutAnotherAccountRowThatHasAPassId()
    {
        Assert.True(HomeSessionWords.CanShutOut(Row(), storeDevice: true));
        Assert.False(HomeSessionWords.CanShutOut(Row(), storeDevice: false));            // Linux, a web-signed phone
        Assert.False(HomeSessionWords.CanShutOut(Row(kind: "console", passId: null), true));   // a console row can only be ended
        Assert.False(HomeSessionWords.CanShutOut(Row(passId: null), true));               // saved before library 0.18.5
        Assert.False(HomeSessionWords.CanShutOut(Row(current: true), true));
        Assert.False(HomeSessionWords.CanEnd(Row(current: true)));                        // the own row has ログアウト, not ログアウトさせる
    }

    [Fact]
    public void TheListAnswerReadsIntoRows()
    {
        var list = System.Text.Json.JsonSerializer.Deserialize<HomeSessionList>("{\"sessions\":[{\"id\":\"a\",\"kind\":\"account\",\"appKind\":\"linux\",\"passId\":\"p\",\"state\":\"active\",\"created\":\"2026-11-23T01:00:00Z\",\"lastUse\":\"2026-11-23T01:05:00Z\",\"current\":true}]}", BellTeam.Core.BellApi.Json)!;
        var row = Assert.Single(list.Sessions);
        Assert.True(row.Current); Assert.Equal("p", row.PassId); Assert.NotNull(HomeSessionWords.Date(row.Created));
    }
}
