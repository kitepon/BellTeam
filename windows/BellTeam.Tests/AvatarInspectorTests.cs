using System.Net;
using System.Net.Http;
using System.Text.Json;
using BellTeam.Core;

namespace BellTeam.Tests;

// W-MAC PR 5: the inspector's image save (PATCH /api/bots/{id}, image fields only) and the texts it reports.
public sealed class AvatarInspectorTests
{
    private static readonly AvatarSelection Selection = new("data:image/jpeg;base64,AAAA", "data:image/jpeg;base64,BBBB", new AvatarCropRect(0.1, 0.2, 0.5, 0.5));
    private static (ManagementApi Api, List<(HttpMethod Method, string Path, string Body)> Calls) Server(Func<HttpRequestMessage, string, HttpResponseMessage> respond)
    {
        var calls = new List<(HttpMethod, string, string)>();
        var handler = new StubHandler(async (request, _) => { var body = request.Content is null ? "" : await request.Content.ReadAsStringAsync(); calls.Add((request.Method, request.RequestUri!.AbsolutePath, body)); return respond(request, body); });
        return (new ManagementApi(new BellApi(new Uri("http://localhost"), handler)), calls);
    }
    private static string Profile(AvatarVariant variant, AvatarSelection value) => variant == AvatarVariant.Small
        ? JsonSerializer.Serialize(new { bot = new { avatar = value.Render, avatarSource = value.Source, avatarCrop = value.Crop, avatarLarge = "", avatarLargeSource = "", avatarLargeCrop = (object?)null } }, BellApi.Json)
        : JsonSerializer.Serialize(new { bot = new { avatar = "", avatarSource = "", avatarCrop = (object?)null, avatarLarge = value.Render, avatarLargeSource = value.Source, avatarLargeCrop = value.Crop } }, BellApi.Json);

    [Theory]
    [InlineData(AvatarVariant.Small, new[] { "avatar", "avatarCrop", "avatarSource" })]
    [InlineData(AvatarVariant.Large, new[] { "avatarLarge", "avatarLargeCrop", "avatarLargeSource" })]
    public async Task SavingSendsOnlyThatImagesThreeFieldsInOnePatch(AvatarVariant variant, string[] keys)
    {
        var (api, calls) = Server((_, _) => StubHandler.Json("{\"bot\":{}}"));
        Assert.Equal(AvatarSaveOutcome.Saved, (await api.SaveAvatarAsync("bot-one", variant, Selection)).Outcome);
        var call = Assert.Single(calls);
        Assert.Equal(HttpMethod.Patch, call.Method); Assert.Equal("/api/bots/bot-one", call.Path);
        using var body = JsonDocument.Parse(call.Body);
        Assert.Equal(keys, body.RootElement.EnumerateObject().Select(property => property.Name).Order(StringComparer.Ordinal).ToArray());
        Assert.Equal(["height", "width", "x", "y"], body.RootElement.GetProperty(keys[1]).EnumerateObject().Select(property => property.Name).Order(StringComparer.Ordinal).ToArray());
    }

    [Fact]
    public async Task ALostConnectionReadsTheResultBackAndNeverSendsAgain()
    {
        var (api, calls) = Server((request, _) => request.Method == HttpMethod.Patch ? throw new HttpRequestException("lost") : StubHandler.Json(Profile(AvatarVariant.Large, Selection)));
        Assert.Equal(AvatarSaveOutcome.Confirmed, (await api.SaveAvatarAsync("bot-one", AvatarVariant.Large, Selection)).Outcome);
        Assert.Equal([HttpMethod.Patch, HttpMethod.Get], calls.Select(call => call.Method).ToArray());
    }

    [Fact]
    public async Task AnUnreadableResultKeepsTheSelectionAndSaysSo()
    {
        var (api, calls) = Server((request, _) => throw new HttpRequestException("lost"));
        var session = new AvatarImageSession();
        await session.SaveAsync(api, "bot-one", AvatarVariant.Small, Selection, _ => "v1", () => Task.CompletedTask, CancellationToken.None);
        Assert.Equal(Selection, session.Pending(AvatarVariant.Small));
        Assert.Equal("保存結果を確認できませんでした。選択は保持しています。\nlost", session.Error(AvatarVariant.Small));
        Assert.Equal(1, calls.Count(call => call.Method == HttpMethod.Patch));
        Assert.False(session.Saving);
    }

    [Fact]
    public async Task ADifferentServerImageKeepsTheSelection()
    {
        var other = Selection with { Render = "data:image/jpeg;base64,CCCC" };
        var (api, _) = Server((request, _) => request.Method == HttpMethod.Patch ? throw new HttpRequestException("lost") : StubHandler.Json(Profile(AvatarVariant.Small, other)));
        var session = new AvatarImageSession();
        await session.SaveAsync(api, "bot-one", AvatarVariant.Small, Selection, _ => "v1", () => Task.CompletedTask, CancellationToken.None);
        Assert.Equal("サーバーの画像は選んだ内容と一致しません。選択は保持しています。", session.Error(AvatarVariant.Small));
        Assert.NotNull(session.Pending(AvatarVariant.Small));
    }

    [Fact]
    public async Task ASavedImageClearsTheSelectionAndReportsOnce()
    {
        var (api, _) = Server((_, _) => StubHandler.Json("{\"bot\":{}}"));
        var session = new AvatarImageSession();
        await session.SaveAsync(api, "bot-one", AvatarVariant.Large, Selection, _ => "L1", () => Task.CompletedTask, CancellationToken.None);
        Assert.Null(session.Pending(AvatarVariant.Large)); Assert.Equal("画像を保存しました。", session.Message); Assert.Null(session.Error(AvatarVariant.Large));
        session.Discard(AvatarVariant.Large); Assert.Equal("選択を破棄しました。", session.Message);
    }

    [Fact]
    public async Task AFailedRefreshIsAnErrorUntilTheRosterShowsANewVersion()
    {
        var (api, _) = Server((_, _) => StubHandler.Json("{\"bot\":{}}"));
        var session = new AvatarImageSession(); var version = "v1";
        await session.SaveAsync(api, "bot-one", AvatarVariant.Small, Selection, _ => version, () => throw new HttpRequestException("refresh"), CancellationToken.None);
        Assert.Equal("画像を保存しましたが、表示を更新できませんでした。\nrefresh", session.Error(AvatarVariant.Small));
        session.VersionChanged(AvatarVariant.Small);
        Assert.Null(session.Error(AvatarVariant.Small)); Assert.Equal("画像を保存しました。", session.Message);
        // The roster already moved on before the refresh failed: the display is current, so it is a success.
        var second = new AvatarImageSession();
        await second.SaveAsync(api, "bot-one", AvatarVariant.Small, Selection, _ => version, () => { version = "v2"; throw new HttpRequestException("refresh"); }, CancellationToken.None);
        Assert.Null(second.Error(AvatarVariant.Small)); Assert.Equal("画像を保存しました。", second.Message);
    }

    [Fact]
    public async Task ConfirmingAKeptSelectionClosesTheSheetAndSaysConfirmed()
    {
        var (api, _) = Server((_, _) => StubHandler.Json(Profile(AvatarVariant.Large, Selection)));
        var session = new AvatarImageSession(); session.Keep(AvatarVariant.Large, Selection, "x");
        Assert.True(await session.ConfirmAsync(api, "bot-one", AvatarVariant.Large, _ => "L1", () => Task.CompletedTask, CancellationToken.None));
        Assert.Null(session.Pending(AvatarVariant.Large)); Assert.Equal("画像の保存を確認しました。", session.Message);
    }

    [Fact]
    public async Task AnOlderServerWithoutTheLargeFieldsCannotEditTheImagesApart()
    {
        var (older, _) = Server((_, _) => StubHandler.Json("{\"bot\":{\"avatar\":\"\"}}"));
        Assert.False((await older.GetAvatarProfileAsync("bot-one")).SupportsIndependentImages);
        var (current, _) = Server((_, _) => StubHandler.Json(Profile(AvatarVariant.Small, Selection)));
        Assert.True((await current.GetAvatarProfileAsync("bot-one")).SupportsIndependentImages);
        Assert.Equal("画像の独立編集はサーバー更新後に利用できます。", BotProfileText.UnsupportedServer);
    }

    [Fact]
    public void TheLargeSlotFallsBackToTheSmallImageAndEmptyAiRowsSayCliDefault()
    {
        Assert.True(JsonSerializer.Deserialize<Bot>("""{"id":"a","name":"a","displayName":"a","avatarVersion":"v1"}""", BellApi.Json)!.UsesSmallImage);
        Assert.True(JsonSerializer.Deserialize<Bot>("""{"id":"a","name":"a","displayName":"a","avatarVersion":"v1","avatarLargeVersion":"v1"}""", BellApi.Json)!.UsesSmallImage);
        Assert.False(JsonSerializer.Deserialize<Bot>("""{"id":"a","name":"a","displayName":"a","avatarVersion":"v1","avatarLargeVersion":"L1"}""", BellApi.Json)!.UsesSmallImage);
        Assert.Equal("CLIの既定", BotProfileText.OrDefault("")); Assert.Equal("gpt-6.1-sol", BotProfileText.OrDefault("gpt-6.1-sol"));
        // Mac #1124 AI card: one line for the four default combinations, and an unknown harness keeps its id.
        Assert.Equal(["モデルとエフォートはCLIの既定で動きます", "モデルはCLIの既定で動きます", "エフォートはCLIの既定で動きます", "選んだモデルとエフォートで動きます"],
            [BotProfileText.AiSummary("", ""), BotProfileText.AiSummary("", "high"), BotProfileText.AiSummary("opus", ""), BotProfileText.AiSummary("opus", "high")]);
        Assert.Equal(("Claude", "Antigravity", "kimi"), (BotProfileText.HarnessName("claude"), BotProfileText.HarnessName("antigravity"), BotProfileText.HarnessName("kimi")));
    }

    [Theory]
    [InlineData(AvatarVariant.Small, 512)]
    [InlineData(AvatarVariant.Large, 1024)]
    public void ACropRectangleRoundTripsThroughThePlacement(AvatarVariant variant, int side)
    {
        Assert.Equal(side, variant.Side());
        var crop = new AvatarCrop(1000, 500, side); crop.SetZoom(2); crop.MoveTo(40, -10);
        var restored = AvatarCrop.From(1000, 500, side, crop.Rect)!;
        Assert.Equal(crop.Zoom, restored.Zoom, 6); Assert.Equal(crop.OffsetX, restored.OffsetX, 6); Assert.Equal(crop.OffsetY, restored.OffsetY, 6);
        Assert.Null(AvatarCrop.From(1000, 500, side, new AvatarCropRect(0.8, 0, 0.5, 1)));
    }
}
