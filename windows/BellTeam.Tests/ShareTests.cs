using System.Net;
using System.Text.Json;
using BellTeam.Core;

namespace BellTeam.Tests;

// conversation forward.md "Share-in": the Core half of receiving content from another app.
public sealed class ShareTests
{
    [Fact]
    public void OnlyHttpLinksAreSharedAsUrlsAtMostTwentyAndOfALimitedLength()
    {
        var links = ShareContent.WebLinks(["https://example.com/a", "ftp://example.com/x", "not a url", "https://example.com/a", "http://example.com/b", "https://example.com/" + new string('x', 2000)]);
        Assert.Equal(["https://example.com/a", "http://example.com/b"], links);
        Assert.Equal(ShareContent.UrlLimit, ShareContent.WebLinks(Enumerable.Range(0, 50).Select(index => $"https://example.com/{index}")).Length);
        Assert.False(new ShareContent(null, "  ", []).HasContent(0));
        Assert.True(new ShareContent(null, null, []).HasContent(1));
        Assert.True(new ShareContent(null, null, ["https://example.com"]).HasContent(0));
    }

    [Fact]
    public async Task ShareIsSentAsContentAndItsRefusalsAreSaidPlainly()
    {
        string? body = null;
        var api = new BellApi(new Uri("http://localhost"), new StubHandler(async (request, _) => { body = await request.Content!.ReadAsStringAsync(); return StubHandler.Json("""{"id":"m1","delivery_id":"d1"}"""); }));
        await api.SendAsync(new ChatTarget("planning", true), "確認お願いします", [], null, default, share: new ShareContent("LINE", "文章\r\n二行目", ["https://example.com/a"]));
        using var json = JsonDocument.Parse(body!);
        var share = json.RootElement.GetProperty("share");
        Assert.Equal(("LINE", "文章\n二行目", "https://example.com/a"), (share.GetProperty("app").GetString(), share.GetProperty("text").GetString(), share.GetProperty("urls")[0].GetString()));
        Assert.Equal("確認お願いします", json.RootElement.GetProperty("message").GetString());
        // Empty parts are left out: the server refuses a share with an empty list or text.
        await api.SendAsync(new ChatTarget("bot-one", false), "", [new ImageAttachment("a.png", "image/png", [1])], null, default, share: new ShareContent(null, null, []));
        using var imageOnly = JsonDocument.Parse(body!);
        Assert.Empty(imageOnly.RootElement.GetProperty("share").EnumerateObject());
        Assert.Contains("ファイルを外して", Timeline.ShareRefusal(new BellApiException("x", HttpStatusCode.UnsupportedMediaType, "FILE_NOT_SUPPORTED")));
        Assert.Contains("2万字", Timeline.ShareRefusal(new BellApiException("x", HttpStatusCode.BadRequest, "ORIGIN_INVALID")));
    }
}
