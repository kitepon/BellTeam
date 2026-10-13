using System.Net.Http;
using System.Text.Json;
using System.Windows;
using System.Windows.Controls;
using System.Windows.Documents;
using System.Windows.Input;
using System.Windows.Interop;
using System.Windows.Threading;
using System.Reflection;
using BellTeam.Core;

namespace BellTeam.Tests;

public sealed class NewlineTests
{
    [Fact]
    public void WpfPlainTextEnterHandlerAndSelectionInsertionContainCrLf()
    {
        RunSta(() =>
        {
            var input = new TextBox { AcceptsReturn = true, Text = "前" }; input.CaretIndex = input.Text.Length;
            using var source = new HwndSource(new HwndSourceParameters("BellTeam非表示改行試験") { Width = 300, Height = 200, WindowStyle = unchecked((int)0x80000000), ExtendedWindowStyle = 0x08000000 }) { RootVisual = input };
            input.Measure(new Size(300, 200)); input.Arrange(new Rect(0, 0, 300, 200));
            var frame = new DispatcherFrame(); Dispatcher.CurrentDispatcher.BeginInvoke(DispatcherPriority.Background, new Action(() => frame.Continue = false)); Dispatcher.PushFrame(frame);
            // キーボードのフォーカスを奪わず、Enterの標準処理を直接呼ぶ。
            var assembly = typeof(TextBox).Assembly;
            var editor = assembly.GetType("System.Windows.Documents.TextEditor")!.GetMethod("_GetTextEditor", BindingFlags.Static | BindingFlags.NonPublic)!.Invoke(null, [input]);
            assembly.GetType("System.Windows.Documents.TextEditorTyping")!.GetMethod("HandleEnterBreakForPlainText", BindingFlags.Static | BindingFlags.NonPublic)!.Invoke(null, [editor]);
            Assert.Equal("前\r\n", input.Text);
            input.SelectedText = "後\r\n次";
            Assert.Contains("後\r\n次", input.Text);
        });
    }
    [Fact]
    public async Task MessagesAnswersAndChangedManagementFieldsSendLf()
    {
        var expected = new Queue<(string Path, string Field, string Value)>([
            ("/api/bots/bot-bell/messages", "message", "前\n後"), ("/api/owner-questions/question-a/answer", "text", "前\n後"),
            ("/api/bots/bot-bell", "profileText", "前\n後"), ("/api/rooms", "purpose", "前\n後"), ("/api/rooms/room-a", "purpose", "前\n後")]);
        using var api = new BellApi(new("http://localhost/"), new StubHandler(async (request, token) =>
        {
            var item = expected.Dequeue(); Assert.Equal(item.Path, request.RequestUri!.AbsolutePath);
            using var body = JsonDocument.Parse(await request.Content!.ReadAsStringAsync(token)); Assert.Equal(item.Value, body.RootElement.GetProperty(item.Field).GetString());
            return StubHandler.Json(item.Field switch
            {
                "text" => """{"question":{"id":"question-a","botId":"bot-bell","question":"質問","options":[],"allowOther":true,"status":"answered"}}""",
                "profileText" => """{"bot":{"name":"ベル","harness":"codex"}}""",
                "purpose" => """{"room":{"id":"room-a","name":"部屋","memberIds":[]}}""", _ => "{}"
            });
        }));
        await api.SendAsync(new("bot-bell", false), "前\r\n後", null);
        await api.AnswerAsync("question-a", null, "前\r\n後");
        var original = new BotSettings { Name = "ベル", Harness = "codex", ProfileText = "元\nの文", Role = "元\nの担当" };
        var changes = (original with { ProfileText = "前\r\n後", Role = "元\r\nの担当" }).ChangesFrom(original);
        Assert.Single(changes); Assert.False(changes.ContainsKey("role"));
        var management = new ManagementApi(api); await management.SaveBotAsync("bot-bell", changes);
        var room = new RoomSettings("部屋", "元\nの文", [], null, "");
        Assert.Empty((room with { Purpose = "元\r\nの文" }).ChangesFrom(room));
        await management.CreateRoomAsync(room with { Purpose = "前\r\n後" });
        await management.UpdateRoomAsync("room-a", (room with { Purpose = "前\r\n後" }).ChangesFrom(room));
        Assert.Empty(expected);
    }
    private static void RunSta(Action action)
    {
        Exception? failure = null;
        var thread = new Thread(() => { try { action(); } catch (Exception error) { failure = error; } });
        thread.SetApartmentState(ApartmentState.STA); thread.Start(); thread.Join();
        if (failure is not null) System.Runtime.ExceptionServices.ExceptionDispatchInfo.Capture(failure).Throw();
    }
}
