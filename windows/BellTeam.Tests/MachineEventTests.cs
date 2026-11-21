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
    private static TimelineMessage Event(string id, string view, string display, string? toolId = null, string? group = null, bool elsewhere = false, string text = "", bool truncated = false, int? count = null)
    {
        var entry = new Dictionary<string, object?> { ["seq"] = 1, ["view"] = view, ["display"] = display, ["title"] = view, ["text"] = text, ["truncated"] = truncated };
        if (elsewhere) entry["shown_elsewhere"] = true;
        if (group is not null) entry["fold_group"] = group;
        if (count is not null) entry["fold_count"] = count;
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
        Assert.Equal(["a", "b", "c", "d", "e", "g", "h1", "x", "h4"], shown.Select(m => m.Id));   // a result is not pulled up under its tool_use: only neighbours of one fold_group join (e+f, h1+h2+h3)
        Assert.Empty(shown[3].MachineEvent!.Folded); Assert.Equal(["f"], shown[4].MachineEvent!.Folded.Select(m => m.Id)); Assert.Equal(["h2", "h3"], shown[6].MachineEvent!.Folded.Select(m => m.Id));
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

    // a471-thinking-full (machine-stream.md "Thinking is always shown whole"): a shown thinking row draws its whole text, never the one-line message, with no line limit, ellipsis or height cap; the Owner can select it.
    [Fact]
    public void AShownThinkingRowDrawsItsWholeTextSelectableWithNoLimit()
    {
        RunSta(() =>
        {
            using var workspace = new Workspace();
            var whole = string.Join("\n", Enumerable.Range(1, 12).Select(n => $"Sentence {n}: " + new string('x', 70))); // about 1000 characters, several lines
            var row = Event("t", "thinking", "show", text: whole) with { Message = "thinking: " + whole[..110] };
            var entry = new MachineEntry(workspace); entry.Update(row, "ベル");
            var box = LogicalTree.Find<TextBox>(entry).Single();
            Assert.Equal(whole, box.Text); Assert.True(box.IsReadOnly);
            Assert.True(double.IsPositiveInfinity(box.MaxHeight)); Assert.Equal(TextWrapping.Wrap, box.TextWrapping);
            entry.Measure(new Size(600, double.PositiveInfinity));
            Assert.True(entry.DesiredSize.Height > 12 * box.FontSize, $"drawn {entry.DesiredSize.Height}px, cut"); // every line takes room
            // An empty thinking row stays one folded line.
            var empty = new MachineEntry(workspace); empty.Update(Event("e", "thinking", "fold", text: "") with { Message = "thinking (no text)" }, "ベル");
            Assert.Single(LogicalTree.Find<Button>(empty)); Assert.Equal(Visibility.Collapsed, ((UIElement)((FrameworkElement)LogicalTree.Find<TextBox>(empty).Single().Parent).Parent).Visibility);
        });
    }

    // a471-tune-tools: a run of one fold_group is one closed line; n = sum of fold_count (absent counts 1). The hooks between two tools do not split them.
    [Fact]
    public void ARunOfToolsIsOneLineLabelledByTheSumOfFoldCountAndOpensToMembersInOrder()
    {
        RunSta(() =>
        {
            using var workspace = new Workspace();
            string Line(params TimelineMessage[] rows)
            {
                var shown = Timeline.VisibleMachine(rows); Assert.Single(shown);
                var entry = new MachineEntry(workspace); entry.Update(shown[0], "ベル");
                return System.Windows.Automation.AutomationProperties.GetName(LogicalTree.Find<Button>(entry).First());
            }
            TimelineMessage Tool(string id, string name, int? count) => Event(id, "tool_use", "fold", "t" + id, "tools", text: name, count: count);
            Assert.Equal("tools ×2", Line(Tool("a", "Read", 1), Event("h", "hook", "fold", group: "tools", count: 0), Event("r", "tool_result", "fold", "ta", "tools", count: 0), Tool("b", "Bash", 1)));
            Assert.Equal("tool_use: Read", Line(Tool("a", "Read", 1), Event("r", "tool_result", "fold", "ta", "tools", count: 0)));
            Assert.Equal("tools ×2", Line(Event("r", "tool_result", "fold", "ta", "tools", count: 0), Event("h", "hook", "fold", group: "tools", count: 0)));
            Assert.Equal("background ×3", Line(Event("b1", "hook", "fold", group: "background"), Event("b2", "hook", "fold", group: "background"), Event("b3", "hook", "fold", group: "background")));
            // Opened, the members are listed in their own order, each a closed line.
            var run = Timeline.VisibleMachine([Tool("a", "Read", 1), Event("r", "tool_result", "fold", "ta", "tools", count: 0)]);
            var card = new MachineEntry(workspace); card.Update(run[0], "ベル");
            var names = LogicalTree.Find<Button>(card).Select(button => System.Windows.Automation.AutomationProperties.GetName(button)).ToArray();
            Assert.Equal(["tool_use: Read", "tool_use: Read", "tool_result: "], names);
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
            Assert.DoesNotContain(LogicalTree.Find<Button>(card), b => System.Windows.Automation.AutomationProperties.GetName(b).StartsWith("このメッセージ"));
            card.Message = Words(",\"bubble\":true");
            Assert.Empty(LogicalTree.Find<MachineEntry>(card));
            // a471-reply-forward: the marked answer has the same reply, forward and copy icons as a saved bubble.
            Assert.All(new[] { "このメッセージに返信", "このメッセージを転送", "このメッセージをコピー" }, name => Assert.Equal(System.Windows.Visibility.Visible, LogicalTree.Find<Button>(card).Single(b => System.Windows.Automation.AutomationProperties.GetName(b) == name).Visibility));
            var document = LogicalTree.Find<MarkdownView>(card).First().Document;
            var shown = new System.Windows.Documents.TextRange(document.ContentStart, document.ContentEnd).Text;
            Assert.Contains("強調", shown); Assert.DoesNotContain("**", shown);
        });
    }

    // a471-thinking-bubble (machine-stream.md "Thinking is drawn as a bubble"): a shown thinking row is drawn in the answer's bubble from its whole text, slanted, with copy only; a thinking (no text) row stays one folded line.
    [Fact]
    public void AShownThinkingRowIsABubbleWithItsWholeTextSlantedAndCopyOnly()
    {
        RunSta(() =>
        {
            using var workspace = new Workspace();
            var whole = string.Join("\n\n", Enumerable.Range(1, 6).Select(n => $"Sentence {n}: " + new string('x', 70)));
            var card = new MessageCard { Workspace = workspace, Message = Event("t", "thinking", "show", text: whole) with { Message = "thinking: " + whole[..110] } };
            Assert.Empty(LogicalTree.Find<MachineEntry>(card));
            var document = LogicalTree.Find<MarkdownView>(card).First().Document;
            Assert.Contains("Sentence 6:", new System.Windows.Documents.TextRange(document.ContentStart, document.ContentEnd).Text); // the whole text, not the one-line message
            Assert.Equal(System.Windows.FontStyles.Italic, document.FontStyle);
            System.Windows.Visibility Icon(string name) => LogicalTree.Find<Button>(card).Single(b => System.Windows.Automation.AutomationProperties.GetName(b) == name).Visibility;
            Assert.Equal(System.Windows.Visibility.Visible, Icon("このメッセージをコピー"));
            Assert.Equal(System.Windows.Visibility.Collapsed, Icon("このメッセージに返信")); Assert.Equal(System.Windows.Visibility.Collapsed, Icon("このメッセージを転送"));
            var empty = new MessageCard { Workspace = workspace, Message = Event("e", "thinking", "fold", text: "") with { Message = "thinking (no text)" } };
            Assert.Single(LogicalTree.Find<MachineEntry>(empty)); Assert.Empty(LogicalTree.Find<MarkdownView>(empty));
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