using System.Net;
using System.Net.Http;
using System.Text.Json;
using BellTeam.Core;

namespace BellTeam.Tests;

// 稼働中に数えない処理 (a65): the a62 wire read leniently, the row words, and the settings line.
public sealed class RunningExclusionsTests
{
    private const string Wire = """
        {"entries":[
          {"id":"e1","kind":"process","exe":"node","args":["vite","dev"],"scope":"all","decisionId":"K-1","approvedAt":"2026-11-13T14:10:00Z","reason":"開発サーバーは待機中に動き続ける"},
          {"id":"e2","kind":"child","harness":"codex","session":null,"scope":["bot-one","bot-ghost"],"approvedAt":"2026-11-12T01:00:00Z"}],
         "pending":[
          {"action":"add","entry":{"id":"e3","kind":"process","exe":"python","args":["-m","http.server"],"scope":["bot-two"],"reason":"確かめ用"},"decisionId":"K-2","from":"bot-two","filedAt":"2026-11-13T14:20:00Z"},
          {"action":"remove","id":"e1","decisionId":"K-3","from":"bot-ghost","filedAt":"2026-11-13T14:30:00Z"},
          {"action":"add","entry":{"id":"e4","kind":"process","exe":"tail","args":[],"scope":"all"},"decisionId":"K-4","from":"bot-one","filedAt":"2026-11-13T14:40:00Z","approved":true}]}
        """;
    private static string? Name(string id) => id switch { "bot-one" => "ユキ", "bot-two" => "ハル", _ => null };

    [Fact]
    public void RowsNameTheProcessTheMembersAndTheDatesInJst()
    {
        var list = JsonSerializer.Deserialize<RunningExclusionList>(Wire, BellApi.Json)!;
        var entries = RunningExclusions.Entries(list, Name);
        Assert.Equal(("e1", false, "node vite dev", "全員", "承認 11月13日 23:10", "開発サーバーは待機中に動き続ける"), (entries[0].Id, entries[0].Child, entries[0].Summary, entries[0].Scope, entries[0].When, entries[0].Reason));
        Assert.Equal(("codexの子の席", "ユキ、名簿にないメンバー", true, (string?)null), (entries[1].Summary, entries[1].Scope, entries[1].Child, entries[1].Reason));
        var pending = RunningExclusions.Pending(list, Name);
        Assert.All(pending, row => Assert.Null(row.Id)); // nothing to press: the answer is given in Approval Box
        Assert.Equal(("加える提案：python -m http.server", "ハル", "提案 ハル・11月13日 23:20", "確かめ用"), (pending[0].Summary, pending[0].Scope, pending[0].When, pending[0].Reason));
        Assert.Equal(("外す提案：node vite dev", "提案 名簿にないメンバー・11月13日 23:30", (string?)null), (pending[1].Summary, pending[1].When, pending[1].Reason));
        Assert.EndsWith("承認済み、空きを待っています", pending[2].When);
        Assert.Equal("外す提案：一覧にない処理", RunningExclusions.Pending(list with { Entries = [] }, Name)[1].Summary);
        Assert.Equal("対象なし", RunningExclusions.ScopeText(JsonDocument.Parse("\"some\"").RootElement, Name));
    }

    [Fact]
    public void TheSettingsLineCountsEntriesAndWaitingProposalsAndAnOlderServerStaysCalm()
    {
        var list = JsonSerializer.Deserialize<RunningExclusionList>(Wire, BellApi.Json)!;
        Assert.Equal(new SettingsStatus("2件・承認を待っている提案が2件", "承認待ち", SettingsTone.Violet), SettingsSummary.Exclusions(list, false));
        Assert.Equal(new SettingsStatus("2件", "設定済み", SettingsTone.Green), SettingsSummary.Exclusions(list with { Pending = [] }, false));
        Assert.Equal(new SettingsStatus("ありません"), SettingsSummary.Exclusions(JsonSerializer.Deserialize<RunningExclusionList>("""{"entries":[],"pending":[]}""", BellApi.Json), false));
        Assert.Equal(SettingsPage.Exclusions.Detail(), SettingsSummary.Exclusions(null, false).Line);
        Assert.Equal("確認できません", SettingsSummary.Exclusions(null, true).Badge);
        Assert.Equal(RunningExclusionsRead.OldServer, RunningExclusions.Failure(new BellApiException("x", HttpStatusCode.NotFound)));
        Assert.Equal(RunningExclusionsRead.Unavailable, RunningExclusions.Failure(new BellApiException("x", HttpStatusCode.ServiceUnavailable)));
        Assert.Equal(RunningExclusionsRead.Failed, RunningExclusions.Failure(new HttpRequestException("down")));
        Assert.Equal("この処理はもう一覧にありませんでした。", RunningExclusions.RemoveFailure(new BellApiException("x", HttpStatusCode.NotFound)));
        Assert.Contains(SettingsPage.Exclusions, SettingsPages.Groups[0]);
    }
}
