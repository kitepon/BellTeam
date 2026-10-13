using System.ComponentModel;
using System.Net;
using System.Net.Http;
using System.Text.Json;
using System.Windows;
using System.Windows.Controls;
using System.Windows.Threading;
using BellTeam.App;
using BellTeam.Core;

namespace BellTeam.Tests;

public sealed class FastModeTests
{
    private static BotSettings Initial(bool fast = false) => new() { Name = "ベル", Harness = "codex", Model = "test-fast", FastMode = fast };
    private static readonly ModelsResponse Catalog = new() { Models = new()
    {
        ["codex"] = new() { DefaultModel = "test-fast", Efforts = [], Models = [new() { Id = "test-fast", Efforts = [], Fast = true }, new() { Id = "test-normal", Efforts = [], Fast = false }] },
        ["claude"] = new() { DefaultModel = "test-fast", Efforts = [], Models = [new() { Id = "test-fast", Efforts = [], Fast = true }], FastUnavailable = new() { Code = "UNAVAILABLE", Message = "このアカウントでは利用できません。" } }
    } };
    [Theory]
    [InlineData(false, true)]
    [InlineData(true, false)]
    public async Task OnlyChangedFastModeIsPatchedAsBoolean(bool before, bool after)
    {
        var original = Initial(before); Assert.Empty(original.ChangesFrom(original));
        var changes = (original with { FastMode = after }).ChangesFrom(original); Assert.Single(changes);
        using var api = new BellApi(new("http://localhost/"), new StubHandler(async (request, token) =>
        {
            Assert.Equal(HttpMethod.Patch, request.Method); Assert.Equal("/api/bots/bot-bell", request.RequestUri!.AbsolutePath);
            using var body = JsonDocument.Parse(await request.Content!.ReadAsStringAsync(token)); Assert.Single(body.RootElement.EnumerateObject()); Assert.Equal(after, body.RootElement.GetProperty("fastMode").GetBoolean());
            return StubHandler.Json(JsonSerializer.Serialize(new { bot = original with { FastMode = after }, applying = true }, BellApi.Json));
        }));
        var saved = await new ManagementApi(api).SaveBotAsync("bot-bell", changes); Assert.Equal(after, saved.Bot.FastMode); Assert.True(saved.Applying);
        Assert.False((original with { Model = "test-normal" }).ChangesFrom(original).ContainsKey("fastMode"));
    }
    [Theory]
    [InlineData("codex", "", true)]
    [InlineData("codex", "test-fast", true)]
    [InlineData("codex", "test-normal", false)]
    [InlineData("codex", "unknown", true)]
    [InlineData("claude", "test-fast", false)]
    public void PickerUsesDefaultAndNamedModelCapabilities(string harness, string model, bool available)
    {
        RunSta(() =>
        {
            var original = Initial() with { Harness = harness, Model = model };
            var picker = new ModelPicker(original);
            var fast = picker.Children.OfType<CheckBox>().Single(); Assert.False(fast.IsEnabled);
            using var api = CatalogApi(); Await(picker.LoadAsync(new(api), CancellationToken.None));
            Assert.Equal(available, fast.IsEnabled); Assert.Empty(picker.Apply(original).ChangesFrom(original));
            var reason = picker.Children.OfType<TextBlock>().Last();
            Assert.Equal(available ? Visibility.Collapsed : Visibility.Visible, reason.Visibility);
            if (harness == "claude") Assert.Equal("このアカウントでは利用できません。", reason.Text);
            if (available) { fast.IsChecked = true; Assert.True(picker.Apply(original).FastMode); }
        });
    }
    [Fact]
    public void FailedCatalogAndModelChangesKeepSavedFastValueForServerToDecide()
    {
        RunSta(() =>
        {
            var original = Initial(true); var picker = new ModelPicker(original);
            using var unavailable = new BellApi(new("http://localhost/"), new StubHandler((_, _) => Task.FromResult(StubHandler.Json("{\"message\":\"取得できません。\"}", HttpStatusCode.ServiceUnavailable))));
            Await(picker.LoadAsync(new(unavailable), CancellationToken.None)); Assert.True(picker.Apply(original).FastMode); Assert.Empty(picker.Apply(original).ChangesFrom(original)); Assert.True(picker.Children.OfType<CheckBox>().Single().IsEnabled);
            var nextPicker = new ModelPicker(original); using var api = CatalogApi(); Await(nextPicker.LoadAsync(new(api), CancellationToken.None));
            var combos = nextPicker.Children.OfType<ComboBox>().ToArray(); combos[1].SelectedValue = "test-normal";
            var changes = nextPicker.Apply(original).ChangesFrom(original); Assert.Equal("test-normal", changes["model"]); Assert.False(changes.ContainsKey("fastMode")); Assert.True(nextPicker.Children.OfType<CheckBox>().Single().IsEnabled);
            nextPicker.SetSavedFastMode(false); Assert.False(nextPicker.Apply(original).FastMode);
            combos[1].SelectedValue = "test-fast"; Assert.True(nextPicker.Children.OfType<CheckBox>().Single().IsEnabled);
            combos[0].SelectedValue = "claude"; Assert.False(nextPicker.Children.OfType<CheckBox>().Single().IsEnabled);
        });
    }
    [Theory]
    [InlineData("catalog-error")]
    [InlineData("unsupported")]
    [InlineData("account-unavailable")]
    public void EnabledFastCanAlwaysBeTurnedOffButCannotBeTurnedBackOnWhenUnavailable(string reason)
    {
        RunSta(() =>
        {
            var original = Initial(true) with { Harness = reason == "account-unavailable" ? "claude" : "codex", Model = reason == "unsupported" ? "test-normal" : "test-fast" };
            var picker = new ModelPicker(original); var fast = picker.Children.OfType<CheckBox>().Single(); Assert.True(fast.IsEnabled);
            using var api = reason == "catalog-error" ? new BellApi(new("http://localhost/"), new StubHandler((_, _) => Task.FromResult(StubHandler.Json("{\"message\":\"取得できません。\"}", HttpStatusCode.ServiceUnavailable)))) : CatalogApi();
            Await(picker.LoadAsync(new(api), CancellationToken.None)); Assert.True(fast.IsEnabled);
            fast.IsChecked = false; Assert.False(fast.IsEnabled);
            var changes = picker.Apply(original).ChangesFrom(original); Assert.Single(changes); Assert.Equal(false, changes["fastMode"]);
        });
    }
    [Theory]
    [InlineData("BOT_FAST_MODE_UNSUPPORTED")]
    [InlineData("BOT_FAST_MODE_ACCOUNT_UNAVAILABLE")]
    [InlineData("BOT_FAST_MODE_UNAVAILABLE")]
    [InlineData("BOT_FAST_MODE_INVALID")]
    public async Task ServerRejectionUsesItsJapaneseMessage(string code)
    {
        using var api = new BellApi(new("http://localhost/"), new StubHandler((_, _) => Task.FromResult(StubHandler.Json(JsonSerializer.Serialize(new { error = code, message = "この設定ではファストモードを使えません。" }), HttpStatusCode.BadRequest))));
        var error = await Assert.ThrowsAsync<BellApiException>(() => new ManagementApi(api).SaveBotAsync("bot-bell", new() { ["fastMode"] = true }));
        Assert.Equal(HttpStatusCode.BadRequest, error.Status); Assert.Contains("この設定ではファストモードを使えません。", error.Message);
    }
    [Fact]
    public async Task RereadingBotsUpdatesListAndSelectedConversationFastMark()
    {
        var fast = false; var selectedChanged = 0;
        using var workspace = new Workspace(origin => new BellApi(origin, new StubHandler((request, _) => Task.FromResult(StubHandler.Json(request.RequestUri!.AbsolutePath switch
        {
            "/api/session" => "{\"authenticated\":true,\"authMode\":\"local\"}", "/api/bots" => Bots(fast), "/api/rooms" => ApiTests.Rooms, _ => ApiTests.Page
        })))));
        await workspace.ConnectAsync("http://localhost", listen: false); await workspace.SelectAsync(workspace.Entries.Single(entry => !entry.Target.IsRoom));
        workspace.PropertyChanged += (_, args) => { if (args.PropertyName == nameof(Workspace.Selected)) selectedChanged++; };
        Assert.False(workspace.Selected!.FastMode);
        fast = true; await workspace.RefreshManagementAsync(); Assert.True(workspace.Selected!.FastMode); Assert.True(workspace.Entries.Single(entry => !entry.Target.IsRoom).FastMode); Assert.False(workspace.Entries.Single(entry => entry.Target.IsRoom).FastMode);
        fast = false; await workspace.RefreshManagementAsync(); Assert.False(workspace.Selected!.FastMode); Assert.False(workspace.Entries.Single(entry => !entry.Target.IsRoom).FastMode); Assert.Equal(2, selectedChanged);
    }
    [Fact]
    public void PendingSaveDisplaysAuthoritativeFalseAfterUnsupportedModelChange()
    {
        RunSta(() =>
        {
            var patched = false; var submitted = false;
            using var workspace = new Workspace(origin => new BellApi(origin, new StubHandler(async (request, token) =>
            {
                if (request.Method == HttpMethod.Patch)
                {
                    using var body = JsonDocument.Parse(await request.Content!.ReadAsStringAsync(token)); Assert.False(body.RootElement.TryGetProperty("fastMode", out _)); Assert.Equal("test-normal", body.RootElement.GetProperty("model").GetString());
                    patched = true; submitted = true; return StubHandler.Json(JsonSerializer.Serialize(new { bot = Initial(false) with { Model = "test-normal" }, applying = true }, BellApi.Json));
                }
                return StubHandler.Json(request.RequestUri!.AbsolutePath switch
                {
                    "/api/session" => "{\"authenticated\":true,\"authMode\":\"local\"}", "/api/bots" => Bots(!patched), "/api/rooms" => ApiTests.Rooms, "/api/models" => JsonSerializer.Serialize(Catalog, BellApi.Json),
                    "/api/bots/bot-bell" => JsonSerializer.Serialize(new { bot = Initial(true) }, BellApi.Json), _ => ApiTests.Page
                });
            })));
            Await(workspace.ConnectAsync("http://localhost", listen: false));
            var editor = new MemberEditor(workspace, "bot-bell"); Await(editor.InitializeAsync()); Await(editor.ModelLoad);
            var picker = Descendants<ModelPicker>(editor).Single(); picker.Children.OfType<ComboBox>().ElementAt(1).SelectedValue = "test-normal";
            Descendants<Button>(editor).Single(button => (string)button.Content == "保存").RaiseEvent(new RoutedEventArgs(Button.ClickEvent)); Pump();
            Assert.True(submitted); Assert.False(picker.Children.OfType<CheckBox>().Single().IsChecked); Assert.False(workspace.Entries.Single(entry => !entry.Target.IsRoom).FastMode);
            Assert.Contains(Descendants<TextBlock>(editor), text => text.Text.Contains("現在の作業が終わってから適用")); editor.Close();
        });
    }
    private static string Bots(bool fast) => JsonSerializer.Serialize(new { bots = new[] { new { id = "bot-bell", name = "ベル", displayName = "ベル", harness = "codex", model = "test-fast", fastMode = fast } } }, BellApi.Json);
    private static BellApi CatalogApi() => new(new("http://localhost/"), new StubHandler((_, _) => Task.FromResult(StubHandler.Json(JsonSerializer.Serialize(Catalog, BellApi.Json)))));
    private static IEnumerable<T> Descendants<T>(DependencyObject root) where T : DependencyObject { if (root is T found) yield return found; foreach (var child in LogicalTreeHelper.GetChildren(root).OfType<DependencyObject>()) foreach (var item in Descendants<T>(child)) yield return item; }
    private static void Pump() { var frame = new DispatcherFrame(); Dispatcher.CurrentDispatcher.BeginInvoke(DispatcherPriority.Background, new Action(() => frame.Continue = false)); Dispatcher.PushFrame(frame); }
    private static void Await(Task task) { var until = DateTime.UtcNow.AddSeconds(5); while (!task.IsCompleted) { if (DateTime.UtcNow > until) throw new TimeoutException(); Pump(); Thread.Sleep(1); } task.GetAwaiter().GetResult(); }
    private static void RunSta(Action action)
    {
        Exception? failure = null; var thread = new Thread(() => { try { SynchronizationContext.SetSynchronizationContext(new DispatcherSynchronizationContext(Dispatcher.CurrentDispatcher)); action(); } catch (Exception error) { failure = error; } finally { Dispatcher.CurrentDispatcher.InvokeShutdown(); } });
        thread.SetApartmentState(ApartmentState.STA); thread.Start(); thread.Join(); if (failure is not null) System.Runtime.ExceptionServices.ExceptionDispatchInfo.Capture(failure).Throw();
    }
}
