using System.Net;
using System.Net.Http;
using System.Text.Json;
using System.Windows;
using System.Windows.Controls;
using System.Windows.Threading;
using BellTeam.App;
using BellTeam.Core;

namespace BellTeam.Tests;

// W-MAC row 17: the member's state lines (seatLaunch, configurationApplication), model display names, the restart wait and the fork row label.
// JSON fragments below use single quotes for readability; J turns them into the wire's double quotes.
public sealed class MemberStateTests
{
    private static string J(string json) => json.Replace('\'', '"');
    private static Bot ReadBot(string fields, bool online = false) => JsonSerializer.Deserialize<BotsResponse>(J($"{{'bots':[{{'id':'b','name':'ユキ','displayName':'ユキ','online':{(online ? "true" : "false")}{fields}}}]}}"), BellApi.Json)!.Bots.Single();
    private static TimelineMessage ReadMessage(string fields) => JsonSerializer.Deserialize<MessagePage>(J($"{{'items':[{{'id':'m','at':'2026-11-11T00:00:00Z','message':'本文'{fields}}}],'has_more':false}}"), BellApi.Json)!.Items.Single();

    // ---- seatLaunch ----
    [Theory]
    [InlineData(",'seatLaunch':{'code':'TARGET_MISMATCH','action':'端末のホスト鍵を確認してください','terminalId':'mac','at':'2026-11-10T02:00:00Z'}", "端末で起動できません：端末のホスト鍵を確認してください")]
    [InlineData(",'seatLaunch':{'code':'TARGET_MISMATCH','action':null}", "端末で起動できません：TARGET_MISMATCH")]
    [InlineData(",'seatLaunch':{'code':'TARGET_MISMATCH','action':'  '}", "端末で起動できません：TARGET_MISMATCH")]
    [InlineData(",'seatLaunch':{'code':'CODE','action':5}", "端末で起動できません：CODE")]
    [InlineData(",'seatLaunch':{'code':'','action':''}", "端末で起動できません。")]
    [InlineData(",'seatLaunch':{'terminalId':'mac'}", "端末で起動できません。")]
    public void SeatLaunchLineNamesTheActionThenTheCode(string fields, string line) => Assert.Equal(line, ReadBot(fields).SeatLaunch!.Line);

    [Theory]
    [InlineData("")]
    [InlineData(",'seatLaunch':null")]
    [InlineData(",'seatLaunch':'端末で起動できません'")]
    [InlineData(",'seatLaunch':7")]
    [InlineData(",'seatLaunch':true")]
    [InlineData(",'seatLaunch':[{'code':'C'}]")]
    public void AMissingOrMalformedSeatLaunchIsNoneAndTheRosterStillReads(string fields) => Assert.Null(ReadBot(fields).SeatLaunch);

    [Fact]
    public void ARowOfTheRosterCarriesTheLineOnlyForAMember()
    {
        ConversationEntry Entry(ChatTarget target, Bot? bot) => new(target, "名前", "", DateTimeOffset.MinValue, bot, null);
        Assert.Equal("端末で起動できません：C", Entry(new("b", false), ReadBot(",'seatLaunch':{'code':'C'}")).SeatLaunchLine);
        Assert.Null(Entry(new("b", false), ReadBot("")).SeatLaunchLine);
        Assert.Null(Entry(new("r", true), null).SeatLaunchLine);
    }

    // ---- configurationApplication ----
    [Theory]
    [InlineData("pending", false, "現在の作業が終わった後に設定を反映します。適用はまだ確認できていません。", "pending")]
    [InlineData("accepted", true, "CLIが設定変更を受け付けました。", "accepted")]
    [InlineData("failed", true, "設定変更は反映されませんでした。席が応答しませんでした。", "failed")]
    [InlineData("other", true, "保存した希望設定です。稼働中のCLIへの適用は未確認です。", null)]
    [InlineData("other", false, "次回の起動に使う希望設定です。", null)]
    public void TheApplicationLineIsWordedAsTheWebAndMarkedByState(string state, bool online, string line, string? marked)
    {
        var message = state == "failed" ? ",'message':'設定変更は反映されませんでした。席が応答しませんでした。'" : "";
        var bot = ReadBot($",'configurationApplication':{{'state':'{state}'{message}}}", online);
        Assert.Equal(line, ConfigurationApplication.Line(bot)); Assert.Equal(marked, ConfigurationApplication.Marked(bot));
    }

    [Fact]
    public void AFailedRecordWithoutAMessageShowsNoLineAndANewMemberShowsNone()
    {
        Assert.Null(ConfigurationApplication.Line(ReadBot(",'configurationApplication':{'state':'failed','message':''}")));
        Assert.Null(ConfigurationApplication.Line(null)); Assert.Null(ConfigurationApplication.Marked(null));
    }

    [Theory]
    [InlineData("")]
    [InlineData(",'configurationApplication':null")]
    [InlineData(",'configurationApplication':'pending'")]
    [InlineData(",'configurationApplication':[1]")]
    [InlineData(",'configurationApplication':{'state':3,'message':false}")]
    public void ARecordThatIsMissingOrOfTheWrongTypeFallsBackToTheSavedSettingsLine(string fields)
    {
        var bot = ReadBot(fields, online: true);
        Assert.Null(ConfigurationApplication.Marked(bot)); Assert.Equal("保存した希望設定です。稼働中のCLIへの適用は未確認です。", ConfigurationApplication.Line(bot));
    }

    [Fact]
    public void TheEditorLineHasAnIconForTheThreeStatesOnly()
    {
        RunSta(() =>
        {
            var picker = new ModelPicker(new() { Name = "ユキ", Harness = "codex" });
            string[] Shown(params string[] expected) => Texts(picker).Where(text => expected.Contains(text.Text)).Select(text => text.Text).ToArray();
            bool Icon(string glyph) => Texts(picker).Any(text => text.Text == glyph);
            picker.ShowConfiguration(ReadBot(",'configurationApplication':{'state':'pending'}"));
            Assert.Single(Shown("現在の作業が終わった後に設定を反映します。適用はまだ確認できていません。")); Assert.True(Icon(""));
            picker.ShowConfiguration(ReadBot(",'configurationApplication':{'state':'accepted'}"));
            Assert.Single(Shown("CLIが設定変更を受け付けました。")); Assert.True(Icon("")); Assert.False(Icon(""));
            picker.ShowConfiguration(ReadBot(",'configurationApplication':{'state':'failed','message':'反映されませんでした。'}"));
            Assert.Single(Shown("反映されませんでした。")); Assert.True(Icon("")); Assert.False(Icon(""));
            picker.ShowConfiguration(ReadBot("", online: true));
            Assert.Single(Shown("保存した希望設定です。稼働中のCLIへの適用は未確認です。")); Assert.False(Icon("") || Icon("") || Icon(""));
            picker.ShowConfiguration(null);
            Assert.Empty(Shown("保存した希望設定です。稼働中のCLIへの適用は未確認です。"));
        });
    }

    // ---- model display names ----
    [Theory]
    [InlineData(",'display_name':' Opus 5 '", "Opus 5")]
    [InlineData(",'display_name':null", "opus")]
    [InlineData(",'display_name':'   '", "opus")]
    [InlineData(",'display_name':''", "opus")]
    [InlineData("", "opus")]
    public void AModelLabelIsTheTrimmedDisplayNameElseTheId(string field, string label)
    {
        var choice = JsonSerializer.Deserialize<ModelChoice>(J("{'id':'opus','efforts':[]" + field + "}"), BellApi.Json)!;
        Assert.Equal(label, choice.Label); Assert.Equal("opus", choice.Id);
    }

    [Fact]
    public void ThePickersShowTheDisplayNameAndKeepTheIdAsTheValue()
    {
        RunSta(() =>
        {
            var catalog = J("{'models':{'codex':{'defaultModel':'gpt-6','efforts':['high'],'models':[{'id':'gpt-6','efforts':['high'],'fast':true,'display_name':'GPT-6 Sol'},{'id':'gpt-5','efforts':[],'fast':false,'display_name':null}]}}}");
            using var api = new BellApi(new("http://localhost/"), new StubHandler((_, _) => Task.FromResult(StubHandler.Json(catalog))));
            var original = new BotSettings { Name = "ユキ", Harness = "codex", Model = "gpt-6", ReasoningEffort = "high" };
            var picker = new ModelPicker(original); Await(picker.LoadAsync(new(api), CancellationToken.None));
            var model = LogicalTree.Find<ComboBox>(picker).ElementAt(1);
            Assert.Equal(new[] { "CLIの既定", "GPT-6 Sol", "gpt-5", "その他" }, model.ItemsSource.Cast<FormOption>().Select(option => option.Label).ToArray());
            Assert.Equal("gpt-6", model.SelectedValue); Assert.Equal("GPT-6 Sol", ((FormOption)model.SelectedItem).Label);
            model.SelectedValue = "gpt-5"; Assert.Equal("gpt-5", picker.Apply(original).Model);
            model.SelectedValue = "gpt-6"; Assert.Equal("gpt-6", picker.Apply(original).Model);
            Assert.Equal(new[] { ("gpt-6", "GPT-6 Sol"), ("gpt-5", "gpt-5") }, BackgroundAgentChoices.Models(JsonSerializer.Deserialize<ModelsResponse>(catalog, BellApi.Json)!.Models, "codex").Select(item => (item.Id, item.Label)).ToArray());
        });
    }

    // ---- restart ----
    [Fact]
    public async Task RestartWaitsOneHundredEightySecondsAndTheTimeoutIsHonoured()
    {
        Assert.Equal(TimeSpan.FromSeconds(180), ManagementApi.RestartTimeout);
        using var api = new BellApi(new("http://localhost/"), new StubHandler(async (_, token) => { await Task.Delay(Timeout.Infinite, token); return StubHandler.Json("{}"); }));
        await Assert.ThrowsAnyAsync<OperationCanceledException>(() => api.PostAsync<JsonElement>("/api/bots/b/restart", new { }, limit: TimeSpan.FromMilliseconds(50)));
    }

    [Fact]
    public void TheRestartButtonWaitsDisabledThenShowsOneLineAndASecondTapIsNotSent()
    {
        RunSta(() =>
        {
            var release = new TaskCompletionSource<HttpResponseMessage>(); var posts = 0;
            using var workspace = Server(request => { if (request.Method != HttpMethod.Post) return null; posts++; return release.Task; });
            Await(workspace.ConnectAsync("http://localhost", listen: false)); var view = new ProfileView { Workspace = workspace };
            Await(workspace.SelectAsync(workspace.Entries.Single(entry => !entry.Target.IsRoom)));
            var button = Buttons(view).Single(item => System.Windows.Automation.AutomationProperties.GetName(item) == "会話セッションを再起動");
            Assert.True(button.IsEnabled); Assert.DoesNotContain(Texts(view), text => text.Text == "会話を再起動しました。");
            var restarting = view.RestartAsync(workspace, "b");
            Assert.False(button.IsEnabled); Assert.Equal("再起動しています…", System.Windows.Automation.AutomationProperties.GetName(button)); Assert.Contains(Texts(button), text => text.Text == "再起動しています…");
            Await(view.RestartAsync(workspace, "b")); Assert.Equal(1, posts);
            release.SetResult(StubHandler.Json(J("{'restarted':true,'session':'s'}")));
            Await(restarting);
            Assert.True(button.IsEnabled); Assert.Contains(Texts(button), text => text.Text == "会話セッションを再起動");
            Assert.Contains(Texts(view), text => text.Text == "会話を再起動しました。" && text.Visibility == Visibility.Visible); Assert.Equal(1, posts);
        });
    }

    [Fact]
    public void AFailedRestartKeepsTheServerMessageAndIsNotRetried()
    {
        RunSta(() =>
        {
            var posts = 0;
            using var workspace = Server(request => { if (request.Method != HttpMethod.Post) return null; posts++; return Task.FromResult(StubHandler.Json(J("{'error':'RESTART_FAILED','message':'席を起動できませんでした。'}"), HttpStatusCode.ServiceUnavailable)); });
            Await(workspace.ConnectAsync("http://localhost", listen: false)); var view = new ProfileView { Workspace = workspace };
            Await(workspace.SelectAsync(workspace.Entries.Single(entry => !entry.Target.IsRoom)));
            Await(view.RestartAsync(workspace, "b"));
            Assert.Contains(Texts(view), text => text.Text == "BellTeam: 席を起動できませんでした。" && text.Visibility == Visibility.Visible);
            Assert.DoesNotContain(Texts(view), text => text.Text == "会話を再起動しました。" && text.Visibility == Visibility.Visible);
            Assert.True(Buttons(view).Single(item => System.Windows.Automation.AutomationProperties.GetName(item) == "会話セッションを再起動").IsEnabled); Assert.Equal(1, posts);
        });
    }

    // ---- fork rows ----
    [Theory]
    [InlineData(",'seat':{'kind':'fork','fork_id':'f1'}", true)]
    [InlineData(",'seat':{'kind':'main'}", false)]
    [InlineData(",'seat':{'kind':'Fork'}", false)]
    [InlineData(",'seat':{'kind':3}", false)]
    [InlineData(",'seat':{}", false)]
    [InlineData(",'seat':'fork'", false)]
    [InlineData(",'seat':5", false)]
    [InlineData(",'seat':[{'kind':'fork'}]", false)]
    [InlineData(",'seat':null", false)]
    [InlineData("", false)]
    public void OnlyASeatOfKindForkMarksARowAndAnythingElseReadsAsANormalRow(string fields, bool fork)
    {
        var message = ReadMessage(fields); Assert.Equal(fork, message.IsFork); Assert.Equal("本文", message.Message);
    }

    [Fact]
    public void TheForkCapsuleSitsBeforeTheTimeLineOfAForkRowInAMembersChat()
    {
        RunSta(() =>
        {
            using var workspace = Server(_ => null); Await(workspace.ConnectAsync("http://localhost", listen: false)); Await(workspace.SelectAsync(workspace.Entries.Single(entry => !entry.Target.IsRoom)));
            const string Fork = ",'seat':{'kind':'fork'}";
            MessageCard Card(string fields) => new() { Workspace = workspace, Message = ReadMessage(fields) };
            bool Badge(MessageCard card) => Texts(card.Content).Single(text => text.Text == "分身" && System.Windows.Automation.AutomationProperties.GetName(text) == "分身") is { } label && Shown(label);
            Assert.True(Badge(Card(Fork))); Assert.True(Badge(Card(",'direction':'outgoing'" + Fork)));
            Assert.False(Badge(Card(",'seat':'fork'"))); Assert.False(Badge(Card("")));
            // The capsule is the first part of the time line row, before the time and status text.
            var row = Texts(Card(Fork).Content).Select(text => LogicalTreeHelper.GetParent(text)).OfType<StackPanel>().First(panel => panel.Children.Count == 2 && panel.Children[1] is TextBlock { FontSize: 14 } && panel.Children[0] is Border);
            Assert.Equal(Orientation.Horizontal, row.Orientation);
            Await(workspace.SelectAsync(workspace.Entries.Single(entry => entry.Target.IsRoom)));
            Assert.False(Badge(Card(Fork)), "a room's rows carry no seat label");
        });
    }

    // ---- helpers ----
    private static bool Shown(FrameworkElement element) { for (DependencyObject? at = element; at is not null; at = LogicalTreeHelper.GetParent(at)) if (at is UIElement { Visibility: not Visibility.Visible }) return false; return true; }
    private static Workspace Server(Func<HttpRequestMessage, Task<HttpResponseMessage>?> custom) => new(origin => new BellApi(origin, new StubHandler((request, _) =>
        custom(request) ?? Task.FromResult(StubHandler.Json(request.RequestUri!.AbsolutePath switch
        {
            "/api/session" => """{"authenticated":true,"authMode":"local"}""", "/api/owner" => ApiTests.Owner, "/api/queue" => ApiTests.EmptyQueue,
            "/api/bots" => """{"bots":[{"id":"b","name":"ユキ","displayName":"ユキ","harness":"claude","online":true}]}""", "/api/rooms" => ApiTests.Rooms, _ => ApiTests.Page
        })))));
    private static IEnumerable<TextBlock> Texts(object? root) => LogicalTree.Find<TextBlock>(root);
    private static IEnumerable<Button> Buttons(object? root) => LogicalTree.Find<Button>(root);
    private static void Pump() { var frame = new DispatcherFrame(); Dispatcher.CurrentDispatcher.BeginInvoke(DispatcherPriority.Background, new Action(() => frame.Continue = false)); Dispatcher.PushFrame(frame); }
    private static void Await(Task task) { var until = DateTime.UtcNow.AddSeconds(5); while (!task.IsCompleted) { if (DateTime.UtcNow > until) throw new TimeoutException(); Pump(); Thread.Sleep(1); } task.GetAwaiter().GetResult(); }
    private static void RunSta(Action action)
    {
        Exception? failure = null; var thread = new Thread(() => { try { SynchronizationContext.SetSynchronizationContext(new DispatcherSynchronizationContext(Dispatcher.CurrentDispatcher)); action(); } catch (Exception error) { failure = error; } finally { Dispatcher.CurrentDispatcher.InvokeShutdown(); } });
        thread.SetApartmentState(ApartmentState.STA); thread.Start(); thread.Join(); if (failure is not null) System.Runtime.ExceptionServices.ExceptionDispatchInfo.Capture(failure).Throw();
    }
}
