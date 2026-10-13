using System.Net;
using System.Net.Http;
using System.Windows.Documents;
using BellTeam.App;
using BellTeam.Core;

namespace BellTeam.Tests;

public sealed class WorkspaceTests
{
    [Fact]
    public async Task DraftsStayWithTheirConversationAndRoomTargetsSurviveSwitch()
    {
        using var workspace = new Workspace(origin => new BellApi(origin, new StubHandler((request, _) => Task.FromResult(StubHandler.Json(request.RequestUri!.AbsolutePath switch
        {
            "/api/session" => "{\"authenticated\":true,\"authMode\":\"local\"}",
            "/api/bots" => ApiTests.Bots, "/api/owner" => ApiTests.Owner, "/api/queue" => ApiTests.EmptyQueue, "/api/rooms" => ApiTests.Rooms, _ => ApiTests.Page
        })))));
        await workspace.ConnectAsync("http://localhost", listen: false);
        var bot = workspace.Entries.Single(item => !item.Target.IsRoom);
        var room = workspace.Entries.Single(item => item.Target.IsRoom);
        await workspace.SelectAsync(bot); workspace.DraftText = "ベルへの下書き";
        await workspace.SelectAsync(room); workspace.DraftText = "部屋への下書き"; workspace.ReplyMembers[0].Selected = true;
        await workspace.SelectAsync(bot); Assert.Equal("ベルへの下書き", workspace.DraftText);
        await workspace.SelectAsync(room); Assert.Equal("部屋への下書き", workspace.DraftText); Assert.True(workspace.ReplyMembers[0].Selected);
        workspace.Search = "開発";
        Assert.Single(workspace.Entries);
    }

    [Fact]
    public async Task SwitchingConversationsDiscardsAnOldResponse()
    {
        var waiting = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        using var workspace = new Workspace(origin => new BellApi(origin, new StubHandler(async (request, token) =>
        {
            var path = request.RequestUri!.AbsolutePath;
            if (path == "/api/bots/bot-bell/messages") { waiting.SetResult(); await Task.Delay(Timeout.Infinite, token); }
            return StubHandler.Json(path switch { "/api/session" => "{\"authenticated\":true,\"authMode\":\"local\"}", "/api/bots" => ApiTests.Bots, "/api/owner" => ApiTests.Owner, "/api/queue" => ApiTests.EmptyQueue, "/api/rooms" => ApiTests.Rooms, _ => ApiTests.Page });
        })));
        await workspace.ConnectAsync("http://localhost", listen: false);
        var old = workspace.SelectAsync(workspace.Entries.Single(item => !item.Target.IsRoom));
        await waiting.Task;
        await workspace.SelectAsync(workspace.Entries.Single(item => item.Target.IsRoom));
        await old;
        Assert.True(workspace.Selected!.Target.IsRoom);
        Assert.Single(workspace.Messages);
        Assert.False(workspace.Loading);
    }

    [Fact]
    public void MarkdownProducesSelectableNativeTextAndTablesWithoutShowingAWindow()
    {
        Exception? failure = null;
        var thread = new Thread(() =>
        {
            try
            {
                var document = MarkdownView.Parse("# 見出し\n**強調** [資料](https://example.com)\n\n- [x] 確認\n\n> 引用\n\n```csharp\nvar a = 1;\n```\n\n| 列 | 値 |\n| --- | --- |\n| A | 1 |");
                Assert.Contains("見出し", new TextRange(document.ContentStart, document.ContentEnd).Text);
                Assert.Contains(document.Blocks, block => block is Table);
            }
            catch (Exception error) { failure = error; }
        });
        thread.SetApartmentState(ApartmentState.STA); thread.Start(); thread.Join();
        if (failure is not null) System.Runtime.ExceptionServices.ExceptionDispatchInfo.Capture(failure).Throw();
    }

    [Theory]
    [InlineData("A &amp; B", "A & B")]
    [InlineData("<https://example.com>", "https://example.com")]
    [InlineData("***太字と斜体***", "太字と斜体")]
    [InlineData("[資料][ref]\n\n[ref]: https://example.com", "資料")]
    [InlineData("<div>文字</div>", "<div>文字</div>")]
    public void CommonMarkdownRemainsReadable(string source, string expected)
    {
        Exception? failure = null;
        var thread = new Thread(() =>
        {
            try
            {
                var document = MarkdownView.Parse(source);
                Assert.Contains(expected, new TextRange(document.ContentStart, document.ContentEnd).Text);
            }
            catch (Exception error) { failure = error; }
        });
        thread.SetApartmentState(ApartmentState.STA); thread.Start(); thread.Join();
        if (failure is not null) System.Runtime.ExceptionServices.ExceptionDispatchInfo.Capture(failure).Throw();
    }

    [Theory]
    [InlineData("前文 <pasted_content>中身</pasted_content> 後文", "前文", "<pasted_content>中身</pasted_content>", "後文")]
    [InlineData("前の段落\n\n<div>\nHTMLの塊\n</div>\n\n後の段落", "前の段落", "<div>\nHTMLの塊\n</div>", "後の段落")]
    public void HtmlLikeTextKeepsItsSourceAndSurroundingParagraphs(string source, string before, string unknown, string after)
    {
        Exception? failure = null;
        var thread = new Thread(() =>
        {
            try
            {
                var document = MarkdownView.Parse(source);
                var text = new TextRange(document.ContentStart, document.ContentEnd).Text.Replace("\r\n", "\n");
                Assert.Contains(before, text);
                Assert.Contains(unknown, text);
                Assert.Contains(after, text);
            }
            catch (Exception error) { failure = error; }
        });
        thread.SetApartmentState(ApartmentState.STA); thread.Start(); thread.Join();
        if (failure is not null) System.Runtime.ExceptionServices.ExceptionDispatchInfo.Capture(failure).Throw();
    }
}
