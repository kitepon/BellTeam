using System.Net;
using System.Net.Http;
using System.Text.Json;
using System.Windows;
using System.Windows.Controls;
using System.Windows.Media;
using System.Windows.Media.Imaging;
using System.Windows.Threading;
using BellTeam.App;
using BellTeam.Core;

namespace BellTeam.Tests;

// The Mac member and room editors (PR 8): the wire of create and delete, the result texts, the AI section and the room pickers.
public sealed class EditorTests
{
    private const string TwoBots = """{"bots":[{"id":"bot-bell","name":"ベル","displayName":"ベル 開発","harness":"codex","model":"test-fast"},{"id":"bot-two","name":"ミカ","displayName":"ミカ","harness":"codex"}]}""";
    private const string BellProfile = """{"bot":{"id":"bot-bell","name":"ベル","harness":"codex","model":"test-fast"}}""";
    private static readonly ModelsResponse Catalog = new() { Models = new()
    {
        ["codex"] = new() { DefaultModel = "test-fast", Efforts = ["high"], Models = [new() { Id = "test-fast", Efforts = ["high"], Fast = true }, new() { Id = "test-normal", Efforts = [], Fast = false }] }
    } };

    // ---- wire ----
    [Fact]
    public async Task CreateSendsImageFieldsOnlyForTheVariantsChosenOrReset()
    {
        var bodies = new List<JsonElement>();
        using var api = new BellApi(new("http://localhost/"), new StubHandler(async (request, token) =>
        {
            Assert.Equal(HttpMethod.Post, request.Method); Assert.Equal("/api/bots", request.RequestUri!.AbsolutePath);
            bodies.Add(JsonDocument.Parse(await request.Content!.ReadAsStringAsync(token)).RootElement.Clone());
            return StubHandler.Json("""{"bot":{"id":"bot-new","name":"新人","harness":"codex"}}""", HttpStatusCode.Created);
        }));
        var management = new ManagementApi(api); var settings = new BotSettings { Name = "新人", Harness = "codex" };
        await management.CreateBotAsync(settings);
        var crop = new AvatarCropRect(0.1, 0.2, 0.5, 0.5);
        await management.CreateBotAsync(settings, BotImageFields.From(AvatarVariant.Small, new AvatarSelection("data:image/jpeg;base64,AAAA", "data:image/jpeg;base64,BBBB", crop)), BotImageFields.Cleared(AvatarVariant.Large));
        Assert.False(bodies[0].TryGetProperty("avatar", out _)); Assert.False(bodies[0].TryGetProperty("avatarLarge", out _)); Assert.Equal("新人", bodies[0].GetProperty("name").GetString());
        Assert.Equal("data:image/jpeg;base64,AAAA", bodies[1].GetProperty("avatar").GetString()); Assert.Equal("data:image/jpeg;base64,BBBB", bodies[1].GetProperty("avatarSource").GetString());
        Assert.Equal(0.5, bodies[1].GetProperty("avatarCrop").GetProperty("width").GetDouble());
        Assert.Equal("", bodies[1].GetProperty("avatarLarge").GetString()); Assert.Equal("", bodies[1].GetProperty("avatarLargeSource").GetString()); Assert.Equal(JsonValueKind.Null, bodies[1].GetProperty("avatarLargeCrop").ValueKind);
    }

    [Fact]
    public async Task MemberDeletionIsOneDeleteAndTheListDecidesWhenItIsDone()
    {
        var deletes = 0; var listed = true;
        using var workspace = Stubbed((request, _) =>
        {
            if (request.Method == HttpMethod.Delete) { deletes++; Assert.Equal("/api/bots/bot-bell", request.RequestUri!.AbsolutePath); return StubHandler.Json("""{"deleting":"bot-bell"}""", HttpStatusCode.Accepted); }
            return null;
        }, () => listed ? TwoBots : """{"bots":[]}""");
        await workspace.ConnectAsync("http://localhost", listen: false);
        await workspace.RequestBotDeletionAsync("bot-bell");
        Assert.True(workspace.BotDeletionPending("bot-bell"));
        Assert.False(await workspace.ConfirmBotDeletionAsync("bot-bell")); Assert.True(workspace.BotDeletionPending("bot-bell"));
        listed = false;
        Assert.True(await workspace.ConfirmBotDeletionAsync("bot-bell")); Assert.False(workspace.BotDeletionPending("bot-bell"));
        Assert.Equal(1, deletes);
    }

    [Fact]
    public async Task OperationFailureNamesTheUnknownOutcomeOnlyWhenTheServerMayHaveActed()
    {
        Assert.StartsWith("操作の結果を確認できませんでした。再操作する前に、現在の状態を更新して確認してください。", EditorText.Failure(new HttpRequestException("切れた")));
        Assert.StartsWith("操作の結果を確認できませんでした。", EditorText.Failure(new BellApiException("内部エラー", HttpStatusCode.InternalServerError)));
        Assert.Equal("入力が正しくありません。", EditorText.Failure(new BellApiException("入力が正しくありません。", HttpStatusCode.BadRequest)));
        Assert.StartsWith("接続が切れ、保存結果を確認できませんでした。やり直す前にルーム一覧を確認してください。", EditorText.RoomSaveFailure(new HttpRequestException("切れた")));
        Assert.StartsWith("保存結果を確認できませんでした。やり直す前にルーム一覧を確認してください。", EditorText.RoomSaveFailure(new BellApiException("読み取れません")));
        await Task.CompletedTask;
    }

    // ---- the member editor ----
    [Fact]
    public void LostDeleteAnswerLeavesTheConfirmExitAndNeverSendsAgain()
    {
        RunSta(() =>
        {
            var deletes = 0;
            using var workspace = Stubbed((request, _) => { if (request.Method == HttpMethod.Delete) { deletes++; throw new HttpRequestException("接続が切れました。"); } return null; }, () => TwoBots);
            Await(workspace.ConnectAsync("http://localhost", listen: false));
            var editor = new MemberEditorView(workspace, "bot-bell"); Await(editor.InitializeAsync());
            editor.AskDelete(); Assert.True(editor.AlertOpen);
            var alert = Texts(editor).Select(text => text.Text).ToArray();
            Assert.Contains("「ベル 開発」を削除しますか？", alert); Assert.Contains(EditorText.MemberDeleteMessage, alert); Assert.Contains(EditorText.MemberDeleteFooter, alert);
            Assert.Equal(new[] { "削除", "キャンセル" }, Buttons(editor).Where(button => button.Content is "削除" or "キャンセル").Select(button => (string)button.Content).ToArray());
            Await(editor.DeleteAsync());
            Assert.Equal(1, deletes); Assert.Contains(EditorText.DeleteUnconfirmed, Texts(editor).Select(text => text.Text));
            Assert.Contains(Texts(editor), text => text.Text.StartsWith("操作の結果を確認できませんでした。再操作する前に、現在の状態を更新して確認してください。"));
            Assert.False(editor.CanSave); Assert.Equal("閉じる", editor.CloseLabel);
            Assert.DoesNotContain(Buttons(editor), button => button.Content as string == "メンバーを削除"); Assert.Contains(Buttons(editor), button => button.Content as string == "削除結果を確認");
            Await(editor.DeleteAsync()); Assert.Equal(1, deletes);
            Await(editor.ConfirmDeletionAsync());
            Assert.Contains(EditorText.DeleteStillListed, Texts(editor).Select(text => text.Text)); Assert.Equal(1, deletes);
            editor.Dispose();
        });
    }

    [Fact]
    public void AcceptedDeleteShowsTheAcceptedTextUntilTheMemberLeavesTheList()
    {
        RunSta(() =>
        {
            var listed = true;
            using var workspace = Stubbed((request, _) => request.Method == HttpMethod.Delete ? StubHandler.Json("""{"deleting":"bot-bell"}""", HttpStatusCode.Accepted) : null, () => listed ? TwoBots : """{"bots":[{"id":"bot-two","name":"ミカ","displayName":"ミカ"}]}""");
            Await(workspace.ConnectAsync("http://localhost", listen: false));
            var editor = new MemberEditorView(workspace, "bot-bell"); var closed = 0; editor.Closer = () => closed++; Await(editor.InitializeAsync());
            Await(editor.DeleteAsync());
            Assert.Contains(EditorText.DeletePending, Texts(editor).Select(text => text.Text)); Assert.Equal("閉じる", editor.CloseLabel); Assert.False(editor.CanSave); Assert.Equal(0, closed);
            listed = false; Await(workspace.RefreshManagementAsync());
            Assert.Equal(1, closed); editor.Dispose();
        });
    }

    [Theory]
    [InlineData("confirmed")]
    [InlineData("different")]
    [InlineData("unconfirmed")]
    public void SaveWithoutAnAnswerReadsTheServerBackAndNeverSendsAgain(string reading)
    {
        RunSta(() =>
        {
            var patches = 0;
            using var workspace = Stubbed((request, _) =>
            {
                if (request.Method == HttpMethod.Patch) { patches++; throw new HttpRequestException("接続が切れました。"); }
                if (request.RequestUri!.AbsolutePath == "/api/bots/bot-bell" && patches > 0)
                    return reading switch { "confirmed" => StubHandler.Json("""{"bot":{"id":"bot-bell","name":"ベル改","harness":"codex","model":"test-fast"}}"""), "different" => StubHandler.Json(BellProfile), _ => throw new HttpRequestException("読めません。") };
                return null;
            }, () => TwoBots);
            Await(workspace.ConnectAsync("http://localhost", listen: false));
            var editor = new MemberEditorView(workspace, "bot-bell"); Await(editor.InitializeAsync());
            Named<TextBox>(editor, "名前").Text = "ベル改"; Await(editor.SaveAsync());
            Assert.Equal(1, patches);
            var texts = Texts(editor).Select(text => text.Text).ToArray();
            if (reading == "confirmed") { Assert.Contains(EditorText.SaveConfirmed, texts); Assert.Equal("閉じる", editor.CloseLabel); Assert.DoesNotContain(Buttons(editor), button => button.Content as string == "保存結果を確認"); }
            else
            {
                Assert.Equal("キャンセル", editor.CloseLabel); var confirm = Buttons(editor).Single(button => button.Content as string == "保存結果を確認");
                if (reading == "different") Assert.Contains(EditorText.SaveDifferent, texts); else Assert.Contains(texts, text => text.StartsWith("保存結果を確認できませんでした。入力は残しています。\n"));
                Assert.Equal("ベル改", Named<TextBox>(editor, "名前").Text);
                Await(editor.ConfirmSaveAsync()); Assert.Equal(1, patches);
            }
            editor.Dispose();
        });
    }

    [Fact]
    public void NameIsRequiredWithTheMacText()
    {
        RunSta(() =>
        {
            using var workspace = Stubbed((_, _) => null, () => TwoBots);
            Await(workspace.ConnectAsync("http://localhost", listen: false));
            var editor = new MemberEditorView(workspace, null); Await(editor.InitializeAsync()); Await(editor.ReadyTask);
            Await(editor.SaveAsync());
            Assert.Equal("名前を入力してください。", editor.ErrorText); Assert.Contains("名前を入力してください。", Texts(editor).Select(text => text.Text)); editor.Dispose();
        });
    }

    [Fact]
    public void NewMemberShowsTheImageSectionAndEditShowsTheDeleteSection()
    {
        RunSta(() =>
        {
            using var workspace = Stubbed((_, _) => null, () => TwoBots);
            Await(workspace.ConnectAsync("http://localhost", listen: false));
            var created = new MemberEditorView(workspace, null); Await(created.InitializeAsync());
            var labels = Buttons(created).Select(button => button.Content as string ?? ((button.Content as StackPanel)?.Children.OfType<TextBlock>().LastOrDefault()?.Text)).ToArray();
            Assert.Contains("小画像を再調整", labels); Assert.Contains("大画像を再調整", labels); Assert.Contains("大画像を変更", labels); Assert.Contains("小画像を変更", labels);
            Assert.Contains(EditorText.ImagesNeedServerUpdate, Texts(created).Select(text => text.Text)); Assert.DoesNotContain("メンバーを削除", labels);
            Assert.All(new[] { "小画像を再調整", "大画像を再調整" }, label => Assert.False(Buttons(created).Single(button => button.Content as string == label).IsEnabled));
            var edited = new MemberEditorView(workspace, "bot-bell"); Await(edited.InitializeAsync());
            Assert.DoesNotContain(Buttons(edited), button => button.Content as string == "小画像を再調整"); Assert.Contains(Buttons(edited), button => button.Content as string == "メンバーを削除");
            Assert.Equal("キャンセル", edited.CloseLabel); Assert.Equal("保存", edited.SaveLabel);
            created.Dispose(); edited.Dispose();
        });
    }

    // ---- the AI section ----
    [Fact]
    public void ASavedModelNotInTheCatalogIsShownAsOtherWithItsIdAndTheSavedEffortKeepsItsLabel()
    {
        RunSta(() =>
        {
            var original = new BotSettings { Name = "ベル", Harness = "codex", Model = "my-own-model", ReasoningEffort = "ultra" };
            var picker = new ModelPicker(original); using var api = CatalogApi(); Await(picker.LoadAsync(new(api), CancellationToken.None));
            var combos = LogicalTree.Find<ComboBox>(picker).ToArray();
            Assert.Equal("__custom__", combos[1].SelectedValue); Assert.Equal("その他", ((FormOption)combos[1].SelectedItem).Label);
            var custom = Named<TextBox>(picker, "モデルID"); Assert.Equal("my-own-model", custom.Text);
            Assert.Equal(new[] { "CLIの既定", "high", "ultra（現在の設定）" }, combos[2].ItemsSource.Cast<FormOption>().Select(option => option.Label).ToArray()); Assert.Equal("ultra", combos[2].SelectedValue);
            Assert.Empty(picker.Apply(original).ChangesFrom(original));
            custom.Text = "other-id"; Assert.Equal("other-id", picker.Apply(original).Model);
            custom.Text = " "; Assert.Equal(EditorText.FastCustomEmpty, picker.FastReason.Text); Assert.Equal(Visibility.Visible, picker.FastReason.Visibility);
            Assert.Equal("モデルIDを入力してください。", Assert.Throws<ArgumentException>(() => picker.Apply(original)).Message);
        });
    }

    [Fact]
    public void FastModeReasonsFollowTheMacOrder()
    {
        var selection = new ModelSelection("codex", "", "");
        Assert.Equal("モデル候補を読み込めませんでした。", selection.FastUnavailableReason);
        selection.SetCatalog(new() { ["codex"] = new HarnessModels { Models = [new() { Id = "a", Efforts = [], Fast = false }], Efforts = [] } });
        Assert.Equal("既定モデルの対応を確認できません。", selection.FastUnavailableReason);
        selection.SelectModel("a"); Assert.Equal("このモデルはファストモードに対応していません。", selection.FastUnavailableReason);
        selection.SelectModel("unlisted"); Assert.Null(selection.FastUnavailableReason);
        selection.SetCatalog(new() { ["codex"] = new HarnessModels { Models = [], Efforts = [], FastUnavailable = new() { Code = "X", Message = "アカウントの都合です。" }, Error = null } }); Assert.Equal("アカウントの都合です。", selection.FastUnavailableReason);
        selection.SetCatalog(new() { ["codex"] = new HarnessModels { Models = [], Efforts = [], Error = new() { Code = "E", Message = "一覧を作れません。" }, FastUnavailable = new() { Code = "X", Message = "アカウントの都合です。" } } }); Assert.Equal("一覧を作れません。", selection.FastUnavailableReason);
        RunSta(() => { var picker = new ModelPicker(new() { Name = "ベル", Harness = "codex" }); Assert.Equal("モデル候補を読み込んでいます。", picker.FastReason.Text); Assert.False(picker.FastToggle.IsEnabled); });
    }

    // ---- the room editor ----
    [Fact]
    public void RoomRepresentativeOffersNoneAndTheCheckedMembersOnly()
    {
        RunSta(() =>
        {
            using var workspace = Stubbed((request, _) => request.RequestUri!.AbsolutePath == "/api/rooms/room-work" ? StubHandler.Json("""{"room":{"id":"room-work","name":"作業部屋","purpose":"開発","memberIds":["bot-bell"],"representativeId":"bot-bell"}}""") : null, () => TwoBots);
            Await(workspace.ConnectAsync("http://localhost", listen: false));
            var editor = new RoomEditorView(workspace, "room-work"); Await(editor.InitializeAsync());
            string[] Offered() => editor.RepresentativePicker.ItemsSource.Cast<FormOption>().Select(option => option.Id).ToArray();
            Assert.Equal(new[] { "", "bot-bell" }, Offered()); Assert.Equal("bot-bell", editor.RepresentativePicker.SelectedValue);
            Assert.Equal(new[] { "ベル 開発", "ミカ" }, editor.Members.Select(item => (string)item.Choice.Content).ToArray());
            editor.Members[1].Choice.IsChecked = true; Assert.Equal(new[] { "", "bot-bell", "bot-two" }, Offered());
            Assert.Equal(new[] { "代表なし", "ベル 開発", "ミカ" }, editor.RepresentativePicker.ItemsSource.Cast<FormOption>().Select(option => option.Label).ToArray());
            editor.Members[0].Choice.IsChecked = false; Assert.Equal(new[] { "", "bot-two" }, Offered()); Assert.Equal("", editor.RepresentativePicker.SelectedValue);
            Assert.Contains(Buttons(editor), button => button.Content as string == "ルームを削除"); Assert.Contains(EditorText.RoomDeleteFooter, Texts(editor).Select(text => text.Text));
            editor.Dispose();
        });
    }

    [Fact]
    public void RoomNameIsRequiredAndAFailureOpensTheMacAlert()
    {
        RunSta(() =>
        {
            var writes = 0;
            using var workspace = Stubbed((request, _) => { if (request.Method != HttpMethod.Get) { writes++; throw new HttpRequestException("切れました。"); } return null; }, () => TwoBots);
            Await(workspace.ConnectAsync("http://localhost", listen: false));
            var editor = new RoomEditorView(workspace, null); Await(editor.InitializeAsync());
            Await(editor.SaveAsync());
            Assert.True(editor.AlertOpen); var texts = Texts(editor).Select(text => text.Text).ToArray(); Assert.Contains("操作を完了できませんでした", texts); Assert.Contains("ルーム名を入力してください。", texts);
            Assert.Equal(0, writes); Assert.True(editor.DismissPopup()); Assert.False(editor.AlertOpen);
            Named<TextBox>(editor, "ルーム名").Text = "新しい部屋"; Await(editor.SaveAsync());
            Assert.Equal(1, writes); Assert.True(editor.AlertOpen); Assert.Contains(Texts(editor), text => text.Text.StartsWith("接続が切れ、保存結果を確認できませんでした。やり直す前にルーム一覧を確認してください。\n"));
            Assert.Equal("キャンセル", editor.CloseLabel); Assert.True(editor.CanSave); editor.Dispose();
        });
    }

    // ---- the crop sheet ----
    [Fact]
    public void CropUseKeepsTheSourceAndCropOnlyWhenAsked()
    {
        RunSta(() =>
        {
            var image = BitmapSource.Create(40, 20, 96, 96, PixelFormats.Bgra32, null, new byte[40 * 20 * 4], 40 * 4); image.Freeze();
            var plain = new AvatarCropView(image).TryUse(); Assert.StartsWith("data:image/jpeg;base64,", plain!.DataUrl); Assert.Null(plain.Selection);
            var view = new AvatarCropView(image, AvatarVariant.Large, new AvatarCropRect(0, 0, 0.5, 1), wantsSelection: true); view.ZoomSlider.Value = 2;
            var kept = view.TryUse()!.Selection!; Assert.StartsWith("data:image/jpeg;base64,", kept.Render); Assert.StartsWith("data:image/jpeg;base64,", kept.Source); Assert.True(kept.Crop.Width <= 1 && kept.Crop.Width > 0);
            Assert.Equal("", view.ErrorText);
        });
    }

    // ---- helpers ----
    private static BellApi CatalogApi() => new(new("http://localhost/"), new StubHandler((_, _) => Task.FromResult(StubHandler.Json(JsonSerializer.Serialize(Catalog, BellApi.Json)))));
    // A workspace whose server answers the list routes, the bot profile and the model catalog; extra answers the test wants come first (null = not handled).
    private static Workspace Stubbed(Func<HttpRequestMessage, CancellationToken, HttpResponseMessage?> custom, Func<string> bots) => new(origin => new BellApi(origin, new StubHandler((request, token) =>
    {
        try
        {
            if (custom(request, token) is { } answer) return Task.FromResult(answer);
            return Task.FromResult(StubHandler.Json(request.RequestUri!.AbsolutePath switch
            {
                "/api/session" => """{"authenticated":true,"authMode":"local"}""", "/api/bots" => bots(), "/api/owner" => ApiTests.Owner, "/api/queue" => ApiTests.EmptyQueue, "/api/rooms" => ApiTests.Rooms,
                "/api/models" => JsonSerializer.Serialize(Catalog, BellApi.Json), "/api/bots/bot-bell" => BellProfile, _ => ApiTests.Page
            }));
        }
        catch (Exception error) { return Task.FromException<HttpResponseMessage>(error); }
    })));
    private static IEnumerable<TextBlock> Texts(DependencyObject root) => Descendants<TextBlock>(root);
    private static IEnumerable<Button> Buttons(DependencyObject root) => Descendants<Button>(root);
    private static T Named<T>(DependencyObject root, string name) where T : DependencyObject => Descendants<T>(root).Single(item => System.Windows.Automation.AutomationProperties.GetName(item) == name);
    private static IEnumerable<T> Descendants<T>(DependencyObject root) where T : DependencyObject { if (root is T found) yield return found; foreach (var child in LogicalTreeHelper.GetChildren(root).OfType<DependencyObject>()) foreach (var item in Descendants<T>(child)) yield return item; }
    private static void Pump() { var frame = new DispatcherFrame(); Dispatcher.CurrentDispatcher.BeginInvoke(DispatcherPriority.Background, new Action(() => frame.Continue = false)); Dispatcher.PushFrame(frame); }
    private static void Await(Task task) { var until = DateTime.UtcNow.AddSeconds(5); while (!task.IsCompleted) { if (DateTime.UtcNow > until) throw new TimeoutException(); Pump(); Thread.Sleep(1); } task.GetAwaiter().GetResult(); }
    private static void RunSta(Action action)
    {
        Exception? failure = null; var thread = new Thread(() => { try { SynchronizationContext.SetSynchronizationContext(new DispatcherSynchronizationContext(Dispatcher.CurrentDispatcher)); action(); } catch (Exception error) { failure = error; } finally { Dispatcher.CurrentDispatcher.InvokeShutdown(); } });
        thread.SetApartmentState(ApartmentState.STA); thread.Start(); thread.Join(); if (failure is not null) System.Runtime.ExceptionServices.ExceptionDispatchInfo.Capture(failure).Throw();
    }
}
