using System.Net;
using System.Net.Http;
using System.Text.Json;
using BellTeam.Core;

namespace BellTeam.Tests;

// The settings home live lines and badges (pure functions of what was loaded), the notification page four states, and the RULES text reader behind チームの決まり (Mac SettingsStatusTests).
public sealed class SettingsStatusTests
{
    private static AIAuthEntry Entry(string id, string name, AuthenticationProgress progress, string? slot = null) => new(id, name, slot, progress);
    private static FeatureSetting Setting(string json) { using var document = JsonDocument.Parse(json); return FeatureSetting.Read(document.RootElement); }
    private static FeatureSetting Feature(string id, string status, bool enabled) => Setting($$"""{"id":"{{id}}","title":"t","enabled":{{(enabled ? "true" : "false")}},"status":"{{status}}","fields":[]}""");
    private static AiControl Control(string state) => JsonSerializer.Deserialize<AiControlResponse>($$$"""{"control":{"paused":true,"state":"{{{state}}}","unconfirmedBotIds":[]}}""", BellApi.Json)!.Control;

    [Fact]
    public void AccountsReadFailureIsUnreadableExceptFor404()
    {
        Assert.Equal(ClaudeAccountsRead.OldServer, ClaudeAccountsReads.Failure(new BellApiException("x", HttpStatusCode.NotFound)));
        Assert.Equal(ClaudeAccountsRead.Unreadable, ClaudeAccountsReads.Failure(new BellApiException("障害", HttpStatusCode.InternalServerError)));
        Assert.Equal(ClaudeAccountsRead.Unreadable, ClaudeAccountsReads.Failure(new BellApiException("x", HttpStatusCode.ServiceUnavailable)));
        Assert.Equal(ClaudeAccountsRead.Unreadable, ClaudeAccountsReads.Failure(new HttpRequestException("timed out")));
        Assert.Equal(ClaudeAccountsRead.Unreadable, ClaudeAccountsReads.Failure(new JsonException("bad body")));
        var unreadable = SettingsSummary.Ai([Entry("claude", "Claude", AuthenticationProgress.Done), Entry("codex", "Codex", AuthenticationProgress.Done), ClaudeAccountsReads.UnreadableEntry]);
        Assert.Equal("確認できません", unreadable.Badge);
        Assert.NotEqual("すべて認証済み", unreadable.Line);
        Assert.True(unreadable.NeedsAttention);
        Assert.Equal(new SettingsRoute(SettingsPage.Ai), unreadable.AttentionRoute); // the list is unreadable: open the list, the seat is unknown
        Assert.Equal("すべて認証済み", SettingsSummary.Ai([Entry("claude", "Claude", AuthenticationProgress.Done), Entry("codex", "Codex", AuthenticationProgress.Done)]).Line);
    }

    [Fact]
    public void AllDoneSaysAllAuthenticatedWithoutAttention()
    {
        var status = SettingsSummary.Ai([Entry("claude", "Claude 1つ目のアカウント", AuthenticationProgress.Done), Entry("codex", "Codex", AuthenticationProgress.Done)]);
        Assert.Equal("すべて認証済み", status.Line);
        Assert.Equal("認証済み", status.Badge);
        Assert.False(status.NeedsAttention);
    }

    [Fact]
    public void WorstStageWinsAndNamesTheAccountAndLinksItsLoginScreen()
    {
        var status = SettingsSummary.Ai([
            Entry("claude", "Claude 1つ目のアカウント", AuthenticationProgress.Done),
            Entry("claude", "Claude 2つ目のアカウント", AuthenticationProgress.NeedsLogin, "2nd"),
            Entry("codex", "Codex", AuthenticationProgress.WaitingCode)]);
        Assert.Equal("Claude 2つ目のアカウントのログインが必要です（ほか1件）", status.Line);
        Assert.Equal("ログインが必要", status.Badge);
        Assert.True(status.NeedsAttention);
        Assert.Equal(new SettingsRoute(SettingsPage.Ai, "claude", "2nd"), status.AttentionRoute);
    }

    [Fact]
    public void FailedOutranksNeedsLoginAndWaitingStaysOutOfTheBand()
    {
        var failed = SettingsSummary.Ai([Entry("a", "A", AuthenticationProgress.NeedsLogin), Entry("b", "B", AuthenticationProgress.Failed("x"))]);
        Assert.Equal(new SettingsRoute(SettingsPage.Ai, "b"), failed.AttentionRoute);
        var waiting = SettingsSummary.Ai([Entry("a", "A", AuthenticationProgress.Done), Entry("codex", "Codex", AuthenticationProgress.WaitingCode)]);
        Assert.Equal("Codexは認証コードの入力待ちです", waiting.Line);
        Assert.False(waiting.NeedsAttention); // the user is operating it right now
    }

    [Fact]
    public void UnreadableAIListIsUnknownNotUnauthenticated()
    {
        foreach (var entries in new IReadOnlyList<AIAuthEntry>?[] { null, [] })
        {
            var status = SettingsSummary.Ai(entries);
            Assert.Equal("確認できません", status.Badge);
            Assert.True(status.NeedsAttention);
        }
        Assert.Equal("Grokの状態を確認できません", SettingsSummary.Ai([Entry("grok", "Grok", AuthenticationProgress.Unknown)]).Line);
    }

    [Fact]
    public void AuthenticationProgressFollowsTheServerAnswer()
    {
        static AuthenticationState Auth(string status, string? stage = null, string? uiMessage = null, string? message = null)
            => new() { Status = status, Message = message, AuthUi = stage is null ? null : new AuthenticationUi { Stage = stage, Message = uiMessage } };
        Assert.Equal(AuthenticationProgress.SendingCode, AuthenticationProgress.From(null, sending: true));
        Assert.Equal(AuthenticationProgress.Unknown, AuthenticationProgress.From(null));
        Assert.Equal(AuthenticationProgress.Checking, AuthenticationProgress.From(null, loaded: false));
        Assert.Equal(AuthenticationProgress.Done, AuthenticationProgress.From(Auth("authenticated")));
        Assert.Equal(AuthenticationProgress.NeedsLogin, AuthenticationProgress.From(Auth("authenticated"), signedOut: true));
        Assert.Equal(AuthenticationProgress.NeedsLogin, AuthenticationProgress.From(Auth("blocked")));
        Assert.Equal(AuthenticationProgress.Failed("no"), AuthenticationProgress.From(Auth("failed", message: "no")));
        Assert.Equal(AuthenticationProgress.WaitingCode, AuthenticationProgress.From(Auth("waiting", "paste_code")));
        Assert.Equal(AuthenticationProgress.WaitingSite, AuthenticationProgress.From(Auth("waiting", "device_code")));
        Assert.Equal(AuthenticationProgress.Confirming, AuthenticationProgress.From(Auth("waiting")));
        Assert.Equal(AuthenticationProgress.Failed("ui"), AuthenticationProgress.From(Auth("waiting", "failed", "ui", "outer")));
        Assert.Equal(AuthenticationProgress.Unknown, AuthenticationProgress.From(Auth("something-new")));
        Assert.Equal("認証できませんでした。理由：理由は返されませんでした。", AuthenticationProgress.Failed("").Detail);
        Assert.Equal("認証し直す", AuthenticationProgress.Failed(null).Action);
        Assert.Null(AuthenticationProgress.Done.Action);
        Assert.True(AuthenticationProgress.Confirming.InProgress);
        Assert.False(AuthenticationProgress.SendingCode.InProgress);
        Assert.Equal(SettingsTone.Violet, AuthenticationProgress.WaitingSite.Tone);
        Assert.Equal("コード待ち", AuthenticationProgress.WaitingCode.Badge);
    }

    [Fact]
    public void NotificationStateDecision()
    {
        Assert.Equal(NotificationState.ServerOff, NotificationStates.Decide(false, OSNotificationAuthorization.Authorized, true)); // server off outranks everything
        Assert.Equal(NotificationState.OsOff, NotificationStates.Decide(true, OSNotificationAuthorization.Denied, false));
        Assert.Equal(NotificationState.OsOff, NotificationStates.Decide(true, OSNotificationAuthorization.Denied, true));
        Assert.Equal(NotificationState.Unregistered, NotificationStates.Decide(true, OSNotificationAuthorization.Authorized, false));
        Assert.Equal(NotificationState.Registered, NotificationStates.Decide(true, OSNotificationAuthorization.Authorized, true));
        Assert.Equal(NotificationState.Unregistered, NotificationStates.Decide(true, null, false)); // before the OS answered it is not "off"
        Assert.Equal(NotificationState.Unregistered, NotificationStates.Decide(true, OSNotificationAuthorization.NotDetermined, false)); // undecided: the button asks
    }

    [Fact]
    public void NotificationBadgesFollowTheFourStatesAndAFailureIsOnlyOnUnregistered()
    {
        Assert.Equal("サーバーで無効", SettingsSummary.Notifications(NotificationState.ServerOff).Badge);
        Assert.Equal("OSでオフ", SettingsSummary.Notifications(NotificationState.OsOff).Badge);
        Assert.Equal("未登録", SettingsSummary.Notifications(NotificationState.Unregistered).Badge);
        Assert.Equal("届きます", SettingsSummary.Notifications(NotificationState.Registered).Badge);
        var failed = SettingsSummary.Notifications(NotificationState.Unregistered, failed: true);
        Assert.Equal("失敗", failed.Badge);
        Assert.True(failed.NeedsAttention);
        Assert.Equal("届きます", SettingsSummary.Notifications(NotificationState.Registered, failed: true).Badge);
    }

    [Fact]
    public void TerminalsCountAndMissingKeys()
    {
        var withKey = new Terminal { TerminalId = "a", KeysRouteAvailable = true, SshKeyConfigured = true };
        var noKey = new Terminal { TerminalId = "b", KeysRouteAvailable = true };
        var oldBody = new Terminal { TerminalId = "c" }; // no key states: the configured flag decides
        var all = SettingsSummary.Terminals(TerminalListState.Supported, [withKey, noKey, oldBody]);
        Assert.Equal("3台・鍵が未設定の端末が2台", all.Line);
        Assert.Equal("未設定", all.Badge);
        oldBody = oldBody with { SshKeyConfigured = true };
        Assert.Equal("2台", SettingsSummary.Terminals(TerminalListState.Supported, [withKey, oldBody]).Line);
        Assert.Equal("設定済み", SettingsSummary.Terminals(TerminalListState.Supported, [withKey, oldBody]).Badge);
        Assert.Equal("未設定", SettingsSummary.Terminals(TerminalListState.Supported, []).Badge);
        Assert.Null(SettingsSummary.Terminals(TerminalListState.Unsupported, null).Badge); // an older body keeps the calm line
        Assert.Null(SettingsSummary.Terminals(TerminalListState.NotLoaded, null).Badge);
        Assert.True(SettingsSummary.Terminals(TerminalListState.Failed, null).NeedsAttention);
    }

    [Fact]
    public void OnePasswordStates()
    {
        var off = Setting("""{"id":"onePassword","title":"1Password連携","enabled":false,"status":"unconfigured","fields":[]}""");
        Assert.Equal("未連携", SettingsSummary.OnePassword(off).Badge);
        var on = Setting("""{"id":"onePassword","title":"1Password連携","enabled":true,"status":"enabled","fields":[],"connection":{"vaults":["A","B"],"sshKeys":2}}""");
        Assert.Equal("保管庫2件・SSH鍵2件", SettingsSummary.OnePassword(on).Line);
        var failed = Setting("""{"id":"onePassword","title":"1Password連携","enabled":true,"status":"enabled","fields":[],"error":{"code":"X","message":"tokenが失効しました。"}}""");
        Assert.Equal("tokenが失効しました。", SettingsSummary.OnePassword(failed).Line);
        Assert.True(SettingsSummary.OnePassword(failed).NeedsAttention);
        Assert.Equal(new SettingsRoute(SettingsPage.OnePassword), SettingsSummary.OnePassword(failed).AttentionRoute);
        Assert.Null(SettingsSummary.OnePassword(null).Badge); // an older body keeps the calm line
    }

    [Fact]
    public void SummaryAgentLineAndOldBody()
    {
        Assert.Null(SettingsSummary.SummaryAgent(null).Badge);
        Assert.Equal("未設定", SettingsSummary.SummaryAgent(new BackgroundAgentRecord(null, null)).Badge);
        var chosen = new BackgroundAgentRecord("r", new("claude", "haiku", ""));
        Assert.Equal("Claude · haiku · CLIの既定", SettingsSummary.SummaryAgent(chosen).Line);
        var catalog = JsonSerializer.Deserialize<ModelsResponse>("""{"models":{"claude":{"efforts":[],"models":[{"id":"haiku","efforts":["low"],"fast":false,"display_name":"Claude Haiku"}]}}}""", BellApi.Json)!.Models;
        Assert.Equal("Claude · Claude Haiku · CLIの既定", SettingsSummary.SummaryAgent(chosen, catalog).Line);
        Assert.Equal("Codex · x · 低", SettingsSummary.SummaryAgent(new BackgroundAgentRecord("r", new("codex", "x", "low"))).Line);
    }

    [Fact]
    public void StopAndRulesLines()
    {
        Assert.Null(SettingsSummary.Stop(null, unreadable: false).Badge);
        Assert.Equal("確認できません", SettingsSummary.Stop(null, unreadable: true).Badge);
        var stopped = Control("stopped");
        Assert.Equal("停止中", SettingsSummary.Stop(stopped, unreadable: false).Badge);
        Assert.True(SettingsSummary.Stop(stopped, unreadable: false).NeedsAttention);
        Assert.Equal("動作中", SettingsSummary.Stop(Control("enabled"), unreadable: false).Badge);
        Assert.Equal(stopped.StatusText, SettingsSummary.StopSentence(AiControlState.Stopped));
        Assert.Equal("未設定", SettingsSummary.Rules("", unreadable: false).Badge);
        Assert.Equal("2件の決まり", SettingsSummary.Rules("SECTION a\n  RULE a.x\n    DO: y\n  RULE a.z\n    DO: w", unreadable: false).Line);
        Assert.Equal("2行の決まり", SettingsSummary.Rules("- 一つ目\n- 二つ目", unreadable: false).Line);
        Assert.True(SettingsSummary.Rules(null, unreadable: true).NeedsAttention);
    }

    [Fact]
    public void FeaturesSummaryCountsUsedAndUnsetWithoutOnePassword()
    {
        var list = new[] { Feature("routing", "enabled", true), Feature("callBridge", "enabled", true), Feature("webPush", "unconfigured", false), Feature("onePassword", "unconfigured", false) };
        Assert.Equal("2つ使用中・1つ未設定", SettingsSummary.Features(list).Line);
        Assert.Null(SettingsSummary.Features([]).Badge); // an older body without the list keeps the calm line
    }

    [Fact]
    public void UpdateBadgeAndAttention()
    {
        Assert.True(SettingsSummary.Update(UpdateKind.Available, "1つ更新できます").NeedsAttention);
        Assert.Equal(new SettingsRoute(SettingsPage.Update), SettingsSummary.Update(UpdateKind.Failed, "x").AttentionRoute);
        Assert.Equal("最新", SettingsSummary.Update(UpdateKind.UpToDate, "すべて最新です").Badge);
        Assert.True(SettingsSummary.Update(UpdateKind.Unreachable, "更新を確認できませんでした").NeedsAttention);
        Assert.False(SettingsSummary.Update(UpdateKind.Updating, "更新しています").NeedsAttention);
        Assert.Equal("確認中", SettingsSummary.Update(UpdateKind.Unconfirmed, "x").Badge);
        Assert.Equal("完了", SettingsSummary.Update(UpdateKind.Completed, "x").Badge);
    }

    [Fact]
    public void PagesKeepTheMacOrderAndWording()
    {
        Assert.Equal(14, Enum.GetValues<SettingsPage>().Length);
        Assert.Equal(["AIの認証", "仕事の要約を書くAI", "端末", "1Password", "通知", "追加機能"], SettingsPages.Groups[0].Select(SettingsPages.Title));
        Assert.Equal([SettingsPage.Rules], SettingsPages.Groups[1]);
        Assert.Equal([SettingsPage.Stop], SettingsPages.Groups[^1]);
        Assert.Equal("全員のAIの動作をまとめて止める", SettingsPage.Stop.Detail());
    }

    [Fact]
    public void RulesTextIsReadAsSectionsRulesAndClauses()
    {
        var text = """
            RULES bellteam.common v1
            FORMAT
              SECTION <topic> groups rules.

            SECTION models
              # Which model to run on.
              RULE models.review
                WHEN: starting real work
                DO: review model, effort and fastMode
                    with get_self.
                WHY: Fable is expensive.
              RULE models.default
                DEFAULT (codex): latest Sol at effort high.
            SECTION guards
              RULE guards.one
                NEVER: wait.
            """;
        var document = UserRulesDocument.Parse(text);
        Assert.Equal(["models", "guards"], document.Sections.Select(section => section.Topic));
        Assert.Equal("Which model to run on.", document.Sections[0].Note);
        Assert.Equal(3, document.RuleCount);
        Assert.Empty(document.PlainLines); // format header lines are not rules or plain text
        var review = document.Sections[0].Rules[0];
        Assert.Equal("models.review", review.Id);
        Assert.Equal(["WHEN", "DO", "WHY"], review.Clauses.Select(clause => clause.Keyword));
        Assert.Equal("review model, effort and fastMode with get_self.", review.Clauses[1].Text); // an indented continuation joins its clause
        Assert.Equal(["いつ", "する", "理由"], review.Clauses.Select(clause => clause.Label));
        var fallback = document.Sections[0].Rules[1].Clauses[0];
        Assert.Equal("DEFAULT (codex)", fallback.Keyword);
        Assert.Equal("既定 (codex)", fallback.Label);
        Assert.Equal("しない", document.Sections[1].Rules[0].Clauses[0].Label);
        Assert.Equal("WHEN", review.Headline?.Keyword); // without a PURPOSE the first clause titles the card
        Assert.Equal(["DO", "WHY"], review.Details.Select(clause => clause.Keyword));
    }

    [Fact]
    public void CrlfTextKeepsItsContinuations()
    {
        var document = UserRulesDocument.Parse("SECTION a\r\n  RULE a.x\r\n    DO: one\r\n      two");
        Assert.Equal("one two", document.Sections[0].Rules[0].Clauses[0].Text);
    }

    [Fact]
    public void PlainBulletsStayPlainAndEmptyIsEmpty()
    {
        var document = UserRulesDocument.Parse("- 初期。\n- 次。\n");
        Assert.Empty(document.Sections);
        Assert.Equal(["- 初期。", "- 次。"], document.PlainLines);
        Assert.Equal(0, document.RuleCount);
        Assert.True(UserRulesDocument.Parse("  \n").IsEmpty);
    }

    [Fact]
    public void RuleWithoutSectionGetsItsTopicFromItsId()
    {
        var document = UserRulesDocument.Parse("RULE style.polite\n  PURPOSE: 丁寧に話す\n  MAY: くだけてよい");
        Assert.Equal(["style"], document.Sections.Select(section => section.Topic));
        Assert.Equal(["目的", "してよい"], document.Sections[0].Rules[0].Clauses.Select(clause => clause.Label));
    }
}
