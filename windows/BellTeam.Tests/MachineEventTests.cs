using System.Net.Http;
using System.Text.Json;
using System.Windows;
using System.Windows.Controls;
using System.Windows.Controls.Primitives;
using BellTeam.App;
using BellTeam.Core;

namespace BellTeam.Tests;

// a471-askuser-windows: the machine seat's stream entries and the question / approval card (conversation machine-stream.md).
public sealed class MachineEventTests
{
    private const string Question = """{"id":"me-7-0","kind":"machine_event","direction":"incoming","at":"2026-11-20T11:00:00Z","message":"question","sender":{"id":"bot-a","name":"ベル"},"machine_event":{"seq":7,"part":0,"launch_id":"l","type":"control_request","subtype":"can_use_tool","view":"question","display":"show","title":"AskUserQuestion","text":"","truncated":false,"request":{"request_id":"r1","status":"pending","questions":[{"header":"方式","question":"どちらにしますか","multiSelect":false,"allowOther":true,"options":[{"index":1,"label":"A","description":"早い"},{"index":2,"label":"B","description":null}]},{"header":null,"question":"足すものは","multiSelect":true,"allowOther":true,"options":[{"index":1,"label":"X","description":null},{"index":2,"label":"Y","description":null}]}]}}}""";
    private static TimelineMessage Row(string json = Question) => JsonSerializer.Deserialize<TimelineMessage>(json, BellApi.Json)!;
    private static TimelineMessage Event(string id, string view, string display, string? toolId = null, string? group = null, bool elsewhere = false, string text = "", bool truncated = false)
    {
        var entry = new Dictionary<string, object?> { ["seq"] = 1, ["view"] = view, ["display"] = display, ["title"] = view, ["text"] = text, ["truncated"] = truncated };
        if (elsewhere) entry["shown_elsewhere"] = true;
        if (group is not null) entry["fold_group"] = group;
        if (toolId is not null) entry["tool"] = new { id = toolId };
        return Row(JsonSerializer.Serialize(new { id, kind = "machine_event", direction = "incoming", at = "2026-11-20T11:00:00Z", message = view + ": " + text, sender = new { id = "bot-a", name = "ベル" }, machine_event = entry }));
    }

    [Fact]
    public void ReadsTheRowAndTheStoredRequestOfTheAnswerRoute()
    {
        var entry = Row().MachineEvent!;
        Assert.Equal("question", entry.View); Assert.Equal("show", entry.Display); Assert.Equal("r1", entry.Request!.RequestId);
        Assert.Equal([1, 2], entry.Request.Questions![0].Options.Select(o => o.Index)); Assert.True(entry.Request.Questions[1].MultiSelect);
        // The answer route names the request id, not request_id, and returns the answers it stored.
        var stored = JsonSerializer.Deserialize<SeatRequestResponse>("""{"request":{"id":"r1","status":"answered","answers":[{"indexes":[1],"other":null},{"indexes":[2],"other":"Z"}]}}""", BellApi.Json)!.Request;
        Assert.Equal("r1", stored.Id); Assert.Equal("answered", stored.Status); Assert.Equal("Z", stored.Answers![1].Other);
    }

    [Fact]
    public void NothingIsHiddenNothingLeavesItsPlaceAndARunOfOneFoldGroupIsOneLine()
    {
        var rows = new[] { Event("a", "words", "show"), Event("b", "system", "hide"), Event("c", "words", "show", elsewhere: true), Event("d", "tool_use", "show", "t1"), Event("e", "tool_result", "fold", "t1", "tool_result"), Event("f", "tool_result", "fold", "t2", "tool_result"), Event("g", "tool_result", "show", "t1"),
            Event("h1", "hook", "fold", group: "hook"), Event("h2", "hook", "fold", group: "hook"), Event("h3", "hook", "fold", group: "hook"), Event("x", "words", "show"), Event("h4", "hook", "fold", group: "hook") };
        var shown = Timeline.VisibleMachine(rows);
        // "hide" is no display: it reads as show. shown_elsewhere is a hint only.
        Assert.Equal(["a", "b", "c", "d", "e", "f", "g", "h1", "x", "h4"], shown.Select(m => m.Id));   // a result is not pulled up under its tool_use; entries without a fold_group stay single lines
        Assert.Empty(shown[3].MachineEvent!.Folded); Assert.Equal(["h2", "h3"], shown[7].MachineEvent!.Folded.Select(m => m.Id));
        // A screen's list folds again to the same lines: Expand is the inverse.
        Assert.Equal(rows.Select(m => m.Id), Timeline.Expand(shown).Select(m => m.Id));
        Assert.Equal(shown.Select(m => m.Id), Timeline.VisibleMachine(shown).Select(m => m.Id));
        Assert.False(Timeline.IsQuotable(Row()));
    }

    [Fact]
    public void AFoldedLineIsClosedUntilPressedThenShowsTheFullTextAndClosesAgain()
    {
        RunSta(() =>
        {
            using var workspace = new Workspace();
            var entry = new MachineEntry(workspace);
            var rows = Timeline.VisibleMachine([Event("e", "tool_result", "fold", "t1", "tool_result", text: "line one\nline two")]);
            entry.Update(rows[0], "ベル");
            var press = LogicalTree.Find<Button>(entry).Single();
            UIElement Opened() => (UIElement)((FrameworkElement)LogicalTree.Find<TextBox>(entry).Single().Parent).Parent;
            Assert.Equal(Visibility.Collapsed, Opened().Visibility);
            press.RaiseEvent(new RoutedEventArgs(ButtonBase.ClickEvent));
            Assert.Equal(Visibility.Visible, Opened().Visibility); Assert.Equal("line one\nline two", LogicalTree.Find<TextBox>(entry).Single().Text);
            // A redraw of the same row keeps it open.
            entry.Update(rows[0] with { Message = "again" }, "ベル");
            Assert.Equal(Visibility.Visible, Opened().Visibility);
            LogicalTree.Find<Button>(entry).Single().RaiseEvent(new RoutedEventArgs(ButtonBase.ClickEvent));
            Assert.Equal(Visibility.Collapsed, Opened().Visibility);
        });
    }

    [Fact]
    public async Task AnswersGoToTheSeatRequestRouteOnceWithIndexesAndOtherOrADecision()
    {
        var seen = new List<(string Path, string Body)>();
        using var api = new BellApi(new("http://localhost/"), new StubHandler(async (request, _) => { seen.Add((request.RequestUri!.AbsolutePath, await request.Content!.ReadAsStringAsync())); return StubHandler.Json("""{"request":{"id":"r1","status":"answered"}}"""); }));
        var done = await api.AnswerSeatRequestAsync("r1", [new() { Indexes = [1] }, new() { Indexes = [2], Other = "Z" }], null);
        await api.AnswerSeatRequestAsync("r2", null, "deny");
        Assert.Equal("answered", done.Status);
        Assert.Equal(("/api/seat-requests/r1/answer", """{"answers":[{"indexes":[1],"other":null},{"indexes":[2],"other":"Z"}]}"""), seen[0]);
        Assert.Equal(("/api/seat-requests/r2/answer", """{"decision":"deny"}"""), seen[1]);
    }

    [Fact]
    public void TheCardSendsOnlyWhenEveryQuestionIsAnsweredAndKeepsPicksAcrossARefresh()
    {
        RunSta(() =>
        {
            using var workspace = new Workspace();
            var entry = new MachineEntry(workspace); var message = Row(); entry.Update(message, "ベル");
            var choices = LogicalTree.Find<ToggleButton>(entry).ToArray(); Assert.Equal(4, choices.Length);
            var send = LogicalTree.Find<Button>(entry).Single(b => b.Content as string == "送る"); Assert.False(send.IsEnabled);
            Press(choices[0]); Assert.False(send.IsEnabled);
            // A single choice and a typed Other exclude each other; a multi-select takes both.
            var boxes = LogicalTree.Find<TextBox>(entry).Where(b => !b.IsReadOnly).ToArray();
            boxes[0].Text = "別案"; Assert.False(choices[0].IsChecked); Assert.False(send.IsEnabled);
            Press(choices[1]); Assert.Equal("", boxes[0].Text);
            Press(choices[2]); Press(choices[3]); boxes[1].Text = "Z"; Assert.True(send.IsEnabled);
            entry.Update(message with { Message = "again" }, "新しい名前");
            Assert.Same(send, LogicalTree.Find<Button>(entry).Single(b => b.Content as string == "送る")); Assert.True(send.IsEnabled);
            var answered = message.MachineEvent! with { Request = message.MachineEvent.Request! with { Status = "answered", Answers = [new() { Indexes = [2] }, new() { Indexes = [1, 2], Other = "Z" }] } };
            entry.Update(message with { MachineEvent = answered }, "ベル");
            Assert.Contains(LogicalTree.Find<TextBlock>(entry), t => t.Text == "回答: B");
            Assert.Contains(LogicalTree.Find<TextBlock>(entry), t => t.Text == "回答: X、Y、Z");
        });
    }

    [Fact]
    public void AnApprovalOffersAllowAndDenyOnlyWhilePending()
    {
        RunSta(() =>
        {
            using var workspace = new Workspace();
            var entry = new MachineEntry(workspace);
            var json = """{"id":"me-9-0","kind":"machine_event","at":"2026-11-20T11:00:00Z","machine_event":{"view":"approval","display":"show","title":"Bash","text":"","tool":{"id":"t","name":"Bash","summary":"ls"},"request":{"request_id":"r9","status":"pending"}}}""";
            entry.Update(Row(json), "ベル");
            Assert.Equal(["許可", "却下"], LogicalTree.Find<Button>(entry).Select(b => (string)b.Content));
            entry.Update(Row(json.Replace("pending", "expired")), "ベル");
            Assert.Empty(LogicalTree.Find<Button>(entry));
        });
    }

    // a471-tune-answer: only a words row the server marked bubble:true is a bubble; the mark arrives later on the same row id, which redraws the card.
    [Fact]
    public void AWordsRowMarkedBubbleIsAnOrdinaryBubbleWithMarkdownAndOthersStayPlainLines()
    {
        RunSta(() =>
        {
            using var workspace = new Workspace();
            TimelineMessage Words(string mark) => Row("{\"id\":\"me-20-0\",\"kind\":\"machine_event\",\"direction\":\"incoming\",\"at\":\"2026-11-20T11:00:00Z\",\"message\":\"words: **強調**です\",\"sender\":{\"id\":\"bot-a\",\"name\":\"ベル\"},\"machine_event\":{\"seq\":20,\"part\":0,\"view\":\"words\",\"display\":\"show\",\"text\":\"**強調**です\"" + mark + "}}");
            var card = new MessageCard { Workspace = workspace, Message = Words("") };
            Assert.Single(LogicalTree.Find<MachineEntry>(card)); Assert.Empty(LogicalTree.Find<MarkdownView>(card));
            card.Message = Words(",\"bubble\":false");
            Assert.Single(LogicalTree.Find<MachineEntry>(card));
            card.Message = Words(",\"bubble\":true");
            Assert.Empty(LogicalTree.Find<MachineEntry>(card));
            var document = LogicalTree.Find<MarkdownView>(card).First().Document;
            var shown = new System.Windows.Documents.TextRange(document.ContentStart, document.ContentEnd).Text;
            Assert.Contains("強調", shown); Assert.DoesNotContain("**", shown);
        });
    }

    private static void Press(ToggleButton button) { button.IsChecked = !button.IsChecked; button.RaiseEvent(new System.Windows.RoutedEventArgs(ButtonBase.ClickEvent)); }

    private static void RunSta(Action action)
    {
        Exception? failure = null; var thread = new Thread(() => { try { action(); } catch (Exception error) { failure = error; } });
        thread.SetApartmentState(ApartmentState.STA); thread.Start(); thread.Join();
        if (failure is not null) System.Runtime.ExceptionServices.ExceptionDispatchInfo.Capture(failure).Throw();
    }
}