using System.IO;
using System.Net;
using System.Net.Http;
using System.Net.Sockets;
using System.Text;
using System.Text.Json;
using System.Windows;
using System.Windows.Controls;
using System.Windows.Media;
using System.Windows.Media.Imaging;
using BellTeam.App;
using BellTeam.Core;

namespace BellTeam.Tests;

public sealed class PhaseTwoTests
{
    private const string FakeSecret = "確認だけに使う秘密の値-DO-NOT-LOG";
    private const string SecretJson = """{"request":{"id":"request-a","botId":"bot-bell","toolId":"test","label":"確認","message":"入力してください","status":"submitted"}}""";
    private const string QuestionJson = """{"question":{"id":"question-a","botId":"bot-bell","question":"選んでください","options":["A","B"],"allowOther":true,"status":"answered","answer":"A"}}""";

    [Fact]
    public async Task SendsImagesWithoutTextAndRestoresThemBeforeNewAttachmentsOnFailure()
    {
        var image = new ImageAttachment("画像.png", "image/png", [1, 2, 3]);
        var draft = new ConversationDraft(); draft.Attachments.Add(image);
        var content = draft.BeginSendContent();
        Assert.Equal("", content.Text); Assert.Empty(draft.Attachments);
        var newer = new ImageAttachment("続き.png", "image/png", [4]); draft.Attachments.Add(newer);
        draft.FailSend(content, "送れませんでした");
        Assert.Equal(new[] { image, newer }, draft.Attachments);
        using var api = new BellApi(new("http://localhost/"), new StubHandler(async (request, token) =>
        {
            using var body = JsonDocument.Parse(await request.Content!.ReadAsStringAsync(token));
            Assert.Equal("", body.RootElement.GetProperty("message").GetString());
            Assert.Equal("AQID", body.RootElement.GetProperty("images")[0].GetProperty("data").GetString());
            return StubHandler.Json("{}");
        }));
        await api.SendAsync(new("bot-bell", false), "", [image], null);
    }

    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    public async Task SecretUsesItsOwnEndpointAndNeverEchoesErrors(bool fail)
    {
        using var api = new BellApi(new("http://localhost/"), new StubHandler(async (request, token) =>
        {
            Assert.Equal("/api/secret-requests/request-a/submit", request.RequestUri!.AbsolutePath);
            Assert.True(request.Headers.CacheControl!.NoStore);
            using var body = JsonDocument.Parse(await request.Content!.ReadAsStringAsync(token));
            Assert.Equal(FakeSecret, body.RootElement.GetProperty("value").GetString());
            if (fail) throw new HttpRequestException(FakeSecret);
            return StubHandler.Json(SecretJson);
        }));
        if (fail)
        {
            using var output = new StringWriter();
            var oldOut = Console.Out; var oldError = Console.Error;
            try
            {
                Console.SetOut(output); Console.SetError(output);
                var error = await Assert.ThrowsAsync<BellApiException>(() => api.FinishSecretAsync("request-a", FakeSecret));
                Assert.DoesNotContain(FakeSecret, error.ToString()); Assert.Null(error.InnerException);
            }
            finally { Console.SetOut(oldOut); Console.SetError(oldError); }
            Assert.DoesNotContain(FakeSecret, output.ToString());
        }
        else Assert.Equal("submitted", (await api.FinishSecretAsync("request-a", FakeSecret)).Status);
    }

    [Fact]
    public async Task SecretPostDoesNotFollow307WithItsBody()
    {
        using var stop = new CancellationTokenSource(TimeSpan.FromSeconds(10));
        using var listener = new TcpListener(IPAddress.Loopback, 0); listener.Start();
        var port = ((IPEndPoint)listener.LocalEndpoint).Port;
        var attempts = 0;
        var serve = Task.Run(async () =>
        {
            try
            {
                for (var index = 0; index < 2; index++)
                {
                    using var socket = await listener.AcceptTcpClientAsync(stop.Token);
                    using var stream = socket.GetStream();
                    var header = new StringBuilder(); var next = new byte[1];
                    while (!header.ToString().EndsWith("\r\n\r\n", StringComparison.Ordinal))
                    {
                        if (await stream.ReadAsync(next, stop.Token) == 0) throw new IOException("要求ヘッダーが途中で終わりました。");
                        header.Append((char)next[0]);
                    }
                    Interlocked.Increment(ref attempts);
                    var response = index == 0
                        ? $"HTTP/1.1 307 Temporary Redirect\r\nLocation: http://127.0.0.1:{port}/redirect\r\nContent-Length: 0\r\nConnection: close\r\n\r\n"
                        : $"HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {Encoding.UTF8.GetByteCount(SecretJson)}\r\nConnection: close\r\n\r\n{SecretJson}";
                    await stream.WriteAsync(Encoding.UTF8.GetBytes(response), stop.Token);
                }
            }
            catch (OperationCanceledException) when (stop.IsCancellationRequested) { }
        });
        try
        {
            using var api = new BellApi(new($"http://127.0.0.1:{port}/"));
            var error = await Assert.ThrowsAsync<BellApiException>(() => api.FinishSecretAsync("request-a", FakeSecret));
            Assert.DoesNotContain(FakeSecret, error.ToString()); Assert.Equal(1, attempts);
        }
        finally { stop.Cancel(); await serve; }
    }

    [Fact]
    public async Task BotScreenStopsWhenReturningToProfile()
    {
        var requests = 0;
        using var workspace = new Workspace(origin => new BellApi(origin, new StubHandler((request, _) =>
        {
            var path = request.RequestUri!.AbsolutePath;
            if (path.EndsWith("/screen", StringComparison.Ordinal)) { requests++; return Task.FromResult(StubHandler.Json("{\"online\":false,\"screen\":\"\"}")); }
            return Task.FromResult(StubHandler.Json(path switch { "/api/session" => "{\"authenticated\":true,\"authMode\":\"local\"}", "/api/bots" => ApiTests.Bots, "/api/owner" => ApiTests.Owner, "/api/queue" => ApiTests.EmptyQueue, "/api/rooms" => ApiTests.Rooms, _ => ApiTests.Page }));
        })));
        await workspace.ConnectAsync("http://localhost", listen: false);
        await workspace.SelectAsync(workspace.Entries.Single(item => !item.Target.IsRoom));
        var read = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        workspace.PropertyChanged += (_, change) => { if (change.PropertyName == nameof(Workspace.ScreenStatus) && workspace.ScreenStatus == "停止中") read.TrySetResult(); };
        var run = workspace.OpenScreenAsync();
        await read.Task.WaitAsync(TimeSpan.FromSeconds(5));
        Assert.Equal("次のメッセージで起動します", workspace.Screen);
        workspace.ReturnToProfile(); await run;
        Assert.False(workspace.ScreenVisible); Assert.Equal(1, requests);
    }

    [Fact]
    public async Task ImageOnlySendFailurePreservesImagesAddedWhileSending()
    {
        var started = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        var finish = new TaskCompletionSource<HttpResponseMessage>(TaskCreationOptions.RunContinuationsAsynchronously);
        using var workspace = new Workspace(origin => new BellApi(origin, new StubHandler(async (request, token) =>
        {
            if (request.Method == HttpMethod.Post)
            {
                using var body = JsonDocument.Parse(await request.Content!.ReadAsStringAsync(token));
                Assert.Equal("", body.RootElement.GetProperty("message").GetString()); Assert.Single(body.RootElement.GetProperty("images").EnumerateArray());
                started.SetResult(); return await finish.Task;
            }
            return StubHandler.Json(request.RequestUri!.AbsolutePath switch { "/api/session" => "{\"authenticated\":true,\"authMode\":\"local\"}", "/api/bots" => ApiTests.Bots, "/api/owner" => ApiTests.Owner, "/api/queue" => ApiTests.EmptyQueue, "/api/rooms" => ApiTests.Rooms, _ => ApiTests.Page });
        })));
        await workspace.ConnectAsync("http://localhost", listen: false);
        await workspace.SelectAsync(workspace.Entries.Single(item => !item.Target.IsRoom));
        var bitmap = BitmapSource.Create(2, 2, 96, 96, PixelFormats.Bgra32, null, new byte[16], 8); bitmap.Freeze();
        workspace.AttachClipboardImage(bitmap); Assert.True(workspace.CanSend);
        var first = workspace.Attachments[0].Data;
        var send = workspace.SendAsync(); await started.Task;
        workspace.AttachClipboardImage(bitmap); Assert.False(workspace.CanSend);
        finish.SetResult(StubHandler.Json("{\"error\":\"SEND_FAILED\"}", HttpStatusCode.ServiceUnavailable)); await send;
        Assert.Equal(2, workspace.Attachments.Length); Assert.Same(first, workspace.Attachments[0].Data); Assert.True(workspace.CanSend);
        Assert.Contains("結果を確認できません", workspace.SendError);
    }

    [Fact]
    public async Task SecretCancellationHasNoValueAndServerErrorBodyIsNotShown()
    {
        using var api = new BellApi(new("http://localhost/"), new StubHandler(async (request, token) =>
        {
            Assert.EndsWith("/cancel", request.RequestUri!.AbsolutePath);
            Assert.Equal("{}", await request.Content!.ReadAsStringAsync(token));
            return StubHandler.Json(JsonSerializer.Serialize(new { error = FakeSecret }), HttpStatusCode.BadRequest);
        }));
        var error = await Assert.ThrowsAsync<BellApiException>(() => api.FinishSecretAsync("request-a", null));
        Assert.DoesNotContain(FakeSecret, error.ToString());
    }

    [Fact]
    public async Task ReadsImageAndCardFieldsFromActualTimelineShape()
    {
        var json = """{"items":[{"id":"s1","at":"2026-10-13T00:00:00Z","image":true,"image_urls":["/api/message-images/user/a.png","/api/message-images/user/b.gif"],"secret_request":{"id":"request-a","botId":"bot-bell","toolId":"test","label":"確認","message":"入力してください","status":"pending"},"owner_question":{"id":"question-a","botId":"bot-bell","question":"選んでください","options":["A","B"],"allowOther":true,"status":"open"}}],"has_more":false}""";
        using var api = new BellApi(new("http://localhost/"), new StubHandler((_, _) => Task.FromResult(StubHandler.Json(json))));
        var item = (await api.GetAsync<MessagePage>("/api/bots/bot-bell/messages")).Items[0];
        Assert.Equal(2, item.DisplayedImageUrls.Length); Assert.Equal("pending", item.SecretRequest!.Status); Assert.True(item.OwnerQuestion!.AllowOther);
    }

    [Fact]
    public async Task QuestionAnswerAndExportUseExistingApiAndPreserveUnknownExportFields()
    {
        using var api = new BellApi(new("http://localhost/"), new StubHandler(async (request, token) =>
        {
            if (request.Method == HttpMethod.Get) return StubHandler.Json("""{"format":"bellteam.conversation.v1","target":{"kind":"bots"},"messages":[],"extra":"保持"}""");
            Assert.Equal("/api/owner-questions/question-a/answer", request.RequestUri!.AbsolutePath);
            using var body = JsonDocument.Parse(await request.Content!.ReadAsStringAsync(token));
            Assert.Equal("A", body.RootElement.GetProperty("choice").GetString());
            Assert.Equal(JsonValueKind.Null, body.RootElement.GetProperty("text").ValueKind);
            return StubHandler.Json(QuestionJson);
        }));
        Assert.Equal("answered", (await api.AnswerAsync("question-a", "A", null)).Status);
        using var exported = JsonDocument.Parse(await api.ExportAsync(new("bot-bell", false)));
        Assert.Equal("保持", exported.RootElement.GetProperty("extra").GetString());
    }

    [Fact]
    public async Task ImagesRejectOtherOriginsAndNonImageResponses()
    {
        var attempts = 0;
        using var api = new BellApi(new("http://localhost/"), new StubHandler((_, _) => { attempts++; return Task.FromResult(StubHandler.Json("{}")); }));
        await Assert.ThrowsAsync<BellApiException>(() => api.ImageAsync("https://other.example/image.png"));
        Assert.Equal(0, attempts);
        await Assert.ThrowsAsync<BellApiException>(() => api.ImageAsync("/api/message-images/user/a.png"));
    }

    [Theory]
    [InlineData("png")]
    [InlineData("jpeg")]
    [InlineData("gif")]
    [InlineData("webp")]
    public async Task WindowsDecoderReadsTheFourServerImageFormats(string format)
    {
        byte[] bytes;
        if (format == "webp") bytes = Convert.FromBase64String("UklGRiIAAABXRUJQVlA4IBYAAAAwAQCdASoBAAEADsD+JaQAA3AAAAAA");
        else
        {
            BitmapEncoder encoder = format switch { "png" => new PngBitmapEncoder(), "jpeg" => new JpegBitmapEncoder(), _ => new GifBitmapEncoder() };
            encoder.Frames.Add(BitmapFrame.Create(BitmapSource.Create(2, 2, 96, 96, PixelFormats.Bgra32, null, new byte[16], 8)));
            using var stream = new MemoryStream(); encoder.Save(stream); bytes = stream.ToArray();
        }
        var bitmap = await ImageCodec.DecodeAsync(bytes);
        Assert.True(bitmap.IsFrozen); Assert.True(bitmap.PixelWidth > 0); Assert.Equal("image/" + format, ImageCodec.Mime(bytes));
    }

    [Fact]
    public void SecretDialogClearsInputOnFailureDeactivationAndCloseWithoutShowingAWindow()
    {
        RunSta(() =>
        {
            var request = JsonSerializer.Deserialize<SecretResponse>(SecretJson, BellApi.Json)!.Request;
            var window = new SecretInputWindow(request, value => { Assert.Equal(FakeSecret, value); return Task.FromException<SecretRequest>(new InvalidOperationException(FakeSecret)); }, _ => throw new InvalidOperationException());
            window.Input.Password = FakeSecret;
            window.SubmitAsync(true).GetAwaiter().GetResult();
            Assert.Equal("", window.Input.Password); Assert.DoesNotContain(FakeSecret, window.ErrorText.Text);
            window.Input.Password = FakeSecret;
            typeof(Window).GetMethod("OnDeactivated", System.Reflection.BindingFlags.Instance | System.Reflection.BindingFlags.NonPublic)!.Invoke(window, [EventArgs.Empty]);
            Assert.Equal("", window.Input.Password);
            window.Input.Password = FakeSecret; window.Close(); Assert.Equal("", window.Input.Password);
        });
    }

    [Fact]
    public void UpdatingQuestionMetadataDoesNotDiscardTyping()
    {
        RunSta(() =>
        {
            using var workspace = new Workspace();
            var question = JsonSerializer.Deserialize<QuestionResponse>(QuestionJson, BellApi.Json)!.Question with { Status = "open", Answer = null };
            var card = new QuestionCard(workspace, "ベル"); card.Update(question);
            var input = card.Children.OfType<TextBox>().Single(box => !box.IsReadOnly); input.Text = "書きかけ";
            card.Update(question with { Options = ["A", "B"] }, "新しい名前");
            Assert.Same(input, card.Children.OfType<TextBox>().Single(box => !box.IsReadOnly)); Assert.Equal("書きかけ", input.Text);
            card.Update(question with { Status = "answered", Answer = "A" });
            Assert.Contains(card.Children.OfType<TextBlock>(), text => text.Text == "回答: A");
        });
    }

    private static void RunSta(Action action)
    {
        Exception? failure = null; var thread = new Thread(() => { try { action(); } catch (Exception error) { failure = error; } });
        thread.SetApartmentState(ApartmentState.STA); thread.Start(); thread.Join();
        if (failure is not null) System.Runtime.ExceptionServices.ExceptionDispatchInfo.Capture(failure).Throw();
    }
}
