using System.IO;
using System.Text.Json;
using BellTeam.App;
using BellTeam.Core;

namespace BellTeam.Tests;

public sealed class SettingsTests
{
    private static AiControl Control(string state, params string[] unconfirmed) => JsonSerializer.Deserialize<AiControlResponse>(
        JsonSerializer.Serialize(new { control = new { paused = state != "enabled", state, updatedAt = (string?)null, unconfirmedBotIds = unconfirmed, commandsConfirmed = (bool?)null, error = (string?)null } }), BellApi.Json)!.Control;

    [Theory]
    [InlineData("enabled", "動作中", "いまは全員が動ける状態です。", false)]
    [InlineData("stopping", "停止中", "全員へ停止の指示を送っています。", true)]
    [InlineData("stopped", "停止中", "全員へ停止の指示を送りました。OFFにすると、また依頼を受け付けます。", false)]
    [InlineData("unconfirmed", "確認できません", "止まったか確かめられませんでした。全体停止はONのままです。", true)]
    public void AiControlStateMapsToRowAndPageText(string state, string row, string status, bool refresh)
    {
        var control = Control(state); Assert.Equal(row, control.RowText); Assert.Equal(status, control.StatusText); Assert.Equal(refresh, control.CanRefresh);
    }
    [Fact]
    public void AiControlReportsUnconfirmedMembersAndBuildsTheRequestBody()
    {
        Assert.Equal("止まったことを確かめられなかったメンバー: 2人", Control("unconfirmed", "a", "b").UnconfirmedText); Assert.Null(Control("stopped", "a").UnconfirmedText);
        Assert.Equal("{\"paused\":true}", JsonSerializer.Serialize(AiControl.Body(true), BellApi.Json));
        Assert.ThrowsAny<JsonException>(() => Control("paused-ish"));
        Assert.Equal("変更を保存できませんでした。現在の状態を表示しています。", AiControl.FailureNote(503, AiControlState.Enabled));
        Assert.Null(AiControl.FailureNote(502, AiControlState.Stopped)); Assert.Equal("停止操作の結果を確認できませんでした。現在の状態を表示しています。", AiControl.FailureNote(502, AiControlState.Enabled));
        Assert.Equal("通信後の現在の状態を読み直しました。", AiControl.FailureNote(null, AiControlState.Enabled));
    }

    private static BackgroundAgentRecord? Record(string json) => BackgroundAgentRecord.Read(JsonDocument.Parse(json).RootElement);
    [Fact]
    public void BackgroundAgentReadsSummaryAndFirstSaveSendsNullRevision()
    {
        Assert.Null(Record("""{"settings":[]}"""));
        var unset = Record("""{"settings":[],"backgroundAgent":{"revision":null,"selection":null}}""")!; Assert.Equal("未設定", unset.Summary);
        var set = Record("""{"backgroundAgent":{"revision":"6f1c1f0e-5d1b-4f43-9a54-0d3a4c2e8b11","selection":{"harness":"codex","model":"gpt-5","reasoningEffort":""}}}""")!;
        Assert.Equal("codex · gpt-5 · CLIの既定", set.Summary);
        Assert.Equal("""{"expectedRevision":null,"harness":"claude","model":"opus","reasoningEffort":"high"}""", JsonSerializer.Serialize(unset.UpdateBody(new("claude", "opus", "high")), BellApi.Json));
        Assert.Equal("6f1c1f0e-5d1b-4f43-9a54-0d3a4c2e8b11", set.UpdateBody(new("codex", "gpt-5", ""))["expectedRevision"]);
    }
    [Fact]
    public void BackgroundAgentChoicesJudgeSaveabilityFromTheCatalogOnly()
    {
        var catalog = new Dictionary<string, HarnessModels>
        {
            ["codex"] = new() { Efforts = [], Models = [new() { Id = "gpt-5", Efforts = ["low", "high"] }, new() { Id = "plain", Efforts = [] }] },
            ["grok"] = new() { Efforts = [], Models = [], Error = new() { Code = "X", Message = "取得できません" } }
        };
        Assert.Null(BackgroundAgentChoices.Problem(catalog, new("codex", "gpt-5", "low")));
        Assert.Equal("このモデルで使えるエフォートを選んでください。", BackgroundAgentChoices.Problem(catalog, new("codex", "gpt-5", "")));
        Assert.Equal("モデルを選んでください。", BackgroundAgentChoices.Problem(catalog, new("codex", "", "")));
        Assert.Equal("保存されているモデルは現在の候補にありません。選び直してください。", BackgroundAgentChoices.Problem(catalog, new("codex", "old", "")));
        Assert.Equal("このモデルはエフォートを指定できません。", BackgroundAgentChoices.Problem(catalog, new("codex", "plain", "low")));
        Assert.Null(BackgroundAgentChoices.Problem(catalog, new("codex", "plain", "")));
        Assert.Equal("取得できません", BackgroundAgentChoices.Problem(catalog, new("grok", "x", "")));
        Assert.Equal("モデル候補を読み込めませんでした。", BackgroundAgentChoices.Problem(catalog, new("cursor", "x", "")));
        Assert.Equal(["low", "high"], BackgroundAgentChoices.Efforts(catalog, "codex", "gpt-5"));
    }

    [Fact]
    public void ConversationOpeningDefaultsToRiseAndPersists()
    {
        var directory = Path.Combine(Path.GetTempPath(), "bellteam-settings-" + Guid.NewGuid().ToString("N"));
        try
        {
            var store = new SettingsStore(directory); Assert.Equal(ConversationOpening.Rise, store.Load().ConversationOpening);
            Directory.CreateDirectory(directory); File.WriteAllText(store.FilePath, """{"serverUrl":"http://a/"}"""); Assert.Equal(ConversationOpening.Rise, store.Load().ConversationOpening);
            store.Save(store.Load() with { ConversationOpening = ConversationOpening.Fade });
            Assert.Contains("\"fade\"", File.ReadAllText(store.FilePath)); Assert.Equal(ConversationOpening.Fade, store.Load().ConversationOpening); Assert.Equal("http://a/", store.Load().ServerUrl);
        }
        finally { if (Directory.Exists(directory)) Directory.Delete(directory, true); }
    }

    [Fact]
    public void HarnessRowStateNeverCallsAnUnreadableStatusUnauthenticated()
    {
        Assert.Equal(("認証済み", "認証し直す"), (HarnessRowState.From("authenticated", null).Title, HarnessRowState.From("authenticated", null).Action));
        Assert.Equal("詳しく見る", HarnessRowState.From("authenticated", false).Action);
        Assert.Equal(("未認証", "認証する"), (HarnessRowState.From("blocked", null).Title, HarnessRowState.From("blocked", null).Action));
        Assert.Equal(("認証中", "続ける"), (HarnessRowState.From("waiting", null).Title, HarnessRowState.From("waiting", null).Action));
        Assert.Equal(HarnessRowState.Unavailable, HarnessRowState.From("failed", null)); Assert.Equal(HarnessRowState.Unavailable, HarnessRowState.From(null, null));
    }

    [Fact]
    public void CategoryListMatchesTheMacOrderAndWording()
    {
        // apple/settings-user-flow.md §3 list order; the profile row sits above the groups.
        Assert.Equal(["AIの認証", "仕事の要約を書くAI", "端末", "稼働中に数えない処理", "1Password", "通知", "追加機能", "チームの決まり", "接続", "表示", "利用と課金", "アップデート", "このアプリについて", "全体停止"], SettingsPageInfo.Groups.SelectMany(group => group).Select(SettingsPageInfo.Title));
        Assert.Equal([7, 1, 2, 3, 1], SettingsPageInfo.Groups.Select(group => group.Length)); Assert.Equal("プロフィール", SettingsPageInfo.Title(SettingsPage.Profile));
        Assert.Equal(("端末", "メンバーの席を動かすMac・Windows・Linuxと、その鍵"), (SettingsPageInfo.Title(SettingsPage.Terminals), SettingsPageInfo.Detail(SettingsPage.Terminals)));
        // Windows sells nothing in the app, so 利用と課金 keeps the Windows line.
        Assert.Equal("料金と、サーバーとAIの契約", SettingsPageInfo.Detail(SettingsPage.Billing));
    }
}
