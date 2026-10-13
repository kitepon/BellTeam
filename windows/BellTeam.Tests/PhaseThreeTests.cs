using System.Net;
using System.Net.Http;
using System.Net.Http.Headers;
using System.Runtime.InteropServices;
using System.Text.Json;
using System.Windows;
using System.Windows.Controls;
using System.Windows.Interop;
using System.Windows.Media;
using System.Windows.Media.Imaging;
using System.Windows.Threading;
using BellTeam.App;
using BellTeam.Core;

namespace BellTeam.Tests;

public sealed class PhaseThreeTests
{
    private static BotSettings Original => new() { Name = "ベル", Harness = "codex", Model = "保存済みのモデル", ReasoningEffort = "high", Role = "元の担当", ProfileText = "原文の改行\n" };
    [Fact]
    public async Task BotPatchContainsOnlyEditedFieldsAndConfirmationIgnoresOtherWriters()
    {
        var changes = (Original with { Name = " 新しい名前 " }).ChangesFrom(Original);
        Assert.Single(changes); Assert.Equal("新しい名前", changes["name"]);
        using var api = new BellApi(new("http://localhost/"), new StubHandler(async (request, token) =>
        {
            if (request.Method == HttpMethod.Patch)
            {
                using var body = JsonDocument.Parse(await request.Content!.ReadAsStringAsync(token));
                Assert.Single(body.RootElement.EnumerateObject()); Assert.False(body.RootElement.TryGetProperty("role", out _)); Assert.False(body.RootElement.TryGetProperty("fastMode", out _));
            }
            return StubHandler.Json(JsonSerializer.Serialize(new { bot = Original with { Name = "新しい名前", Role = "Bot自身が変えた担当" } }, BellApi.Json));
        }));
        var management = new ManagementApi(api);
        await management.SaveBotAsync("bot-bell", changes);
        Assert.True(await management.ConfirmBotAsync("bot-bell", changes));
    }
    [Fact]
    public void UnchangedModelAndRoomMembersAreNotSent()
    {
        Assert.Empty(Original.ChangesFrom(Original));
        var room = new RoomSettings("部屋", "仕事", ["b", "a"], "b", "元の画像");
        var changes = (room with { Name = "部屋2", MemberIds = ["a", "b"] }).ChangesFrom(room);
        Assert.Single(changes); Assert.Equal("部屋2", changes["name"]);
        Assert.False(changes.ContainsKey("avatar"));
    }
    [Fact]
    public void ModelCatalogErrorsAndTextControlsKeepSavedValues()
    {
        var selection = new ModelSelection("codex", "保存済みの未知のモデル", "保存済みのeffort");
        selection.SetCatalog(new() { ["codex"] = new HarnessModels { Models = [], Efforts = [], Error = new() { Code = "UNAVAILABLE", Message = "取得できません" } } });
        Assert.Equal("保存済みの未知のモデル", selection.Model); Assert.Equal("保存済みのeffort", selection.Effort);
        RunSta(() =>
        {
            var body = new TextBox { Text = Original.ProfileText, AcceptsReturn = true };
            Assert.Empty((Original with { ProfileText = body.Text }).ChangesFrom(Original));
            using var api = new BellApi(new("http://localhost/"), new StubHandler((_, _) => Task.FromResult(StubHandler.Json("{\"error\":\"MODEL_CATALOG_UNAVAILABLE\"}", HttpStatusCode.ServiceUnavailable))));
            var picker = new ModelPicker(Original); Assert.Empty(picker.Apply(Original).ChangesFrom(Original));
            Await(picker.LoadAsync(new ManagementApi(api), CancellationToken.None)); Assert.Empty(picker.Apply(Original).ChangesFrom(Original));
        });
    }
    [Fact]
    public async Task RoomCreateUpdateAndDeleteUseTheirOwnMethodsAndOnlyChangedFields()
    {
        var original = new RoomSettings("部屋", "仕事", ["bot-bell"], "bot-bell", "");
        var seen = new List<HttpMethod>();
        using var api = new BellApi(new("http://localhost/"), new StubHandler(async (request, token) =>
        {
            seen.Add(request.Method);
            if (request.Method == HttpMethod.Delete) { Assert.Equal("/api/rooms/room-a", request.RequestUri!.AbsolutePath); return new HttpResponseMessage(HttpStatusCode.NoContent); }
            using var body = JsonDocument.Parse(await request.Content!.ReadAsStringAsync(token));
            if (request.Method == HttpMethod.Post) { Assert.Equal("/api/rooms", request.RequestUri!.AbsolutePath); Assert.Equal("部屋", body.RootElement.GetProperty("name").GetString()); }
            else { Assert.Single(body.RootElement.EnumerateObject()); Assert.Equal("新しい仕事", body.RootElement.GetProperty("purpose").GetString()); }
            return StubHandler.Json("{\"room\":{\"id\":\"room-a\",\"name\":\"部屋\",\"memberIds\":[\"bot-bell\"]}}");
        }));
        var management = new ManagementApi(api);
        await management.CreateRoomAsync(original);
        await management.UpdateRoomAsync("room-a", (original with { Purpose = "新しい仕事" }).ChangesFrom(original));
        await management.DeleteRoomAsync("room-a");
        Assert.Equal(new[] { HttpMethod.Post, HttpMethod.Patch, HttpMethod.Delete }, seen);
    }
    [Fact]
    public void DefaultModelUsesCatalogCapabilitiesWithoutChangingTheSavedSelection()
    {
        var state = new ModelSelection("provider", "", "");
        state.SetCatalog(new() { ["provider"] = new HarnessModels { DefaultModel = "automatic", Efforts = ["high"], Models = [new() { Id = "automatic", Efforts = [] }] } });
        Assert.Empty(state.Efforts); Assert.Equal("", state.Model);
    }
    [Fact]
    public void AvatarCropFillsTheFrameAndEncodes512PixelJpeg()
    {
        var crop = new AvatarCrop(1000, 500); crop.MoveTo(100000, -100000);
        Assert.Equal(0, crop.OffsetY); Assert.Equal(256, crop.OffsetX); Assert.Equal(0, crop.Left);
        crop.SetZoom(2); Assert.Equal(512, crop.OffsetX); Assert.True(crop.Left <= 0); Assert.True(crop.Top <= 0);
        RunSta(() =>
        {
            var source = BitmapSource.Create(4, 2, 96, 96, PixelFormats.Bgra32, null, new byte[32], 16);
            var value = AvatarCropWindow.Encode(source, new AvatarCrop(4, 2));
            Assert.StartsWith("data:image/jpeg;base64,", value);
            var bytes = Convert.FromBase64String(value.Split(',')[1]);
            using var stream = new System.IO.MemoryStream(bytes);
            var result = BitmapDecoder.Create(stream, BitmapCreateOptions.None, BitmapCacheOption.OnLoad).Frames[0];
            Assert.Equal(512, result.PixelWidth); Assert.Equal(512, result.PixelHeight);
        });
    }
    [Fact]
    public void RemovingAvatarWhileDecodeIsPendingDoesNotBringBackTheOldPhoto()
    {
        RunSta(() =>
        {
            var decoded = new TaskCompletionSource<BitmapSource>(TaskCreationOptions.RunContinuationsAsynchronously);
            var picker = new AvatarPicker("data:image/png;base64,AQID", _ => decoded.Task);
            var load = picker.LoadAsync();
            picker.Children.OfType<Button>().Single(button => (string)button.Content == "写真を取り外す").RaiseEvent(new RoutedEventArgs(Button.ClickEvent));
            var bitmap = BitmapSource.Create(2, 2, 96, 96, PixelFormats.Bgra32, null, new byte[16], 8); bitmap.Freeze(); decoded.SetResult(bitmap); Await(load);
            Assert.Equal("", picker.Value); Assert.Null(picker.Children.OfType<Image>().Single().Source);
        });
    }
    [Fact]
    public async Task RemovingRoomAlsoRemovesItsLocalDraft()
    {
        var removed = false;
        using var workspace = new Workspace(origin => new BellApi(origin, new StubHandler((request, _) => Task.FromResult(StubHandler.Json(request.RequestUri!.AbsolutePath switch
        {
            "/api/session" => "{\"authenticated\":true,\"authMode\":\"local\"}", "/api/bots" => ApiTests.Bots, "/api/rooms" => removed ? "{\"rooms\":[]}" : ApiTests.Rooms, _ => ApiTests.Page
        })))));
        await workspace.ConnectAsync("http://localhost", listen: false);
        await workspace.SelectAsync(workspace.Entries.Single(entry => entry.Target.IsRoom)); workspace.DraftText = "削除される部屋の下書き";
        removed = true; await workspace.RefreshManagementAsync(); Assert.Null(workspace.Selected);
        removed = false; await workspace.RefreshManagementAsync(); await workspace.SelectAsync(workspace.Entries.Single(entry => entry.Target.IsRoom));
        Assert.Equal("", workspace.DraftText);
    }

    [Fact]
    public void CollapsingStandardExpanderDuringImageLoadKeepsTheImageLoad()
    {
        RunSta(() =>
        {
            var release = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
            var bitmap = BitmapSource.Create(2, 2, 96, 96, PixelFormats.Bgra32, null, new byte[16], 8);
            var bytes = ImageCodec.Png(bitmap);
            var requests = 0;
            using var workspace = new Workspace(origin => new BellApi(origin, new StubHandler(async (request, token) =>
            {
                if (request.RequestUri!.AbsolutePath.Contains("/message-images/", StringComparison.Ordinal))
                {
                    requests++; await release.Task.WaitAsync(token);
                    var response = new HttpResponseMessage(HttpStatusCode.OK) { Content = new ByteArrayContent(bytes) };
                    response.Content.Headers.ContentType = new MediaTypeHeaderValue("image/png"); return response;
                }
                return StubHandler.Json(request.RequestUri.AbsolutePath switch { "/api/session" => "{\"authenticated\":true,\"authMode\":\"local\"}", "/api/bots" => ApiTests.Bots, "/api/rooms" => ApiTests.Rooms, _ => ApiTests.Page });
            })));
            Await(workspace.ConnectAsync("http://localhost", listen: false));
            var remote = new RemoteImage(workspace, "/api/message-images/user/test.png");
            var expander = new Expander { IsExpanded = true, Header = "メンバー間の連絡", Content = remote };
            var parameters = new HwndSourceParameters("BellTeam非表示試験") { Width = 400, Height = 300, WindowStyle = unchecked((int)0x80000000), ExtendedWindowStyle = 0x08000000 };
            using var source = new HwndSource(parameters) { RootVisual = expander };
            expander.Measure(new Size(400, 300)); expander.Arrange(new Rect(0, 0, 400, 300)); Pump();
            Assert.False(IsWindowVisible(source.Handle)); Assert.True(remote.IsLoaded);
            expander.IsExpanded = false; Pump();
            expander.IsExpanded = true; Pump();
            release.SetResult(); Await(remote.LoadTask);
            Assert.NotNull(remote.Children.OfType<Image>().Single().Source); Assert.Equal(1, requests);
            source.RootVisual = null; Pump();
        });
    }

    [DllImport("user32.dll")]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool IsWindowVisible(IntPtr window);
    private static void Pump()
    {
        var frame = new DispatcherFrame(); Dispatcher.CurrentDispatcher.BeginInvoke(DispatcherPriority.Background, new Action(() => frame.Continue = false)); Dispatcher.PushFrame(frame);
    }
    private static void Await(Task task)
    {
        var deadline = DateTime.UtcNow.AddSeconds(5);
        while (!task.IsCompleted) { if (DateTime.UtcNow > deadline) throw new TimeoutException("非表示の部品試験が時間切れになりました。"); Pump(); Thread.Sleep(1); }
        task.GetAwaiter().GetResult();
    }
    private static void RunSta(Action action)
    {
        Exception? failure = null;
        var thread = new Thread(() => { try { SynchronizationContext.SetSynchronizationContext(new DispatcherSynchronizationContext(Dispatcher.CurrentDispatcher)); action(); } catch (Exception error) { failure = error; } finally { Dispatcher.CurrentDispatcher.InvokeShutdown(); } });
        thread.SetApartmentState(ApartmentState.STA); thread.Start(); thread.Join();
        if (failure is not null) System.Runtime.ExceptionServices.ExceptionDispatchInfo.Capture(failure).Throw();
    }
}
