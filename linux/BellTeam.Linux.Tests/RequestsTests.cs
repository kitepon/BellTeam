using System.Net;
using System.Text;
using System.Text.Json;
using Avalonia.Controls;
using BellTeam.Core;

namespace BellTeam.Linux;

// The schedule page, its editor and the secret input window, over an in-memory server that records what was sent.
public sealed class RequestsTests
{
    private sealed class Server : HttpMessageHandler
    {
        public readonly List<string> Sent = [];
        protected override Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken cancellationToken)
        {
            var path = request.RequestUri!.PathAndQuery;
            if (request.Method != HttpMethod.Get) Sent.Add(request.Method + " " + path);
            var body = path switch
            {
                "/api/session" => """{"authenticated":true,"authMode":"local"}""",
                "/api/setup" => """{"phase":"ready","harnesses":[],"complete":true}""",
                "/api/bots?avatar=omit" => """{"bots":[{"id":"b1","name":"ベル","displayName":"ベル","online":true}]}""",
                "/api/rooms?avatar=omit" => """{"rooms":[]}""",
                "/api/queue" => """{"items":[]}""",
                "/api/owner?avatar=omit" => """{"owner":{"name":"利用者"}}""",
                "/api/schedules" => """{"sources":[{"kind":"bot","id":"b1","name":"ベル","schedules":[{"id":"s2","name":"late","kind":"once","prompt":"p","nextRunAt":"2030-01-02T00:00:00Z","enabled":true},{"id":"s1","name":"soon","kind":"daily","prompt":"p","nextRunAt":"2030-01-01T00:00:00Z","enabled":true},{"id":"s3","name":"off","kind":"daily","prompt":"p","enabled":false}]}]}""",
                _ => null
            };
            return Task.FromResult(body is null ? new HttpResponseMessage(HttpStatusCode.NotFound) : new HttpResponseMessage(HttpStatusCode.OK) { Content = new StringContent(body, Encoding.UTF8, "application/json") });
        }
    }

    private sealed class Host : ISheetHost
    {
        public Control? Opened;
        public void OpenSheet(string title, Control content) => Opened = content;
        public void CloseSheet() => Opened = null;
    }

    private static async Task<LinuxWorkspace> ConnectAsync(Server server)
    {
        var workspace = new LinuxWorkspace(origin => new BellApi(origin, server));
        await workspace.ConnectAsync("http://localhost:1/", listen: false);
        return workspace;
    }

    [Fact]
    public Task SchedulesShowTheSoonestFirstAndOmitADisabledOneWithoutANextRun() => Ui.Run(async () =>
    {
        var server = new Server(); using var workspace = await ConnectAsync(server);
        var page = new SchedulesPage(workspace, new Host());
        await page.InitializeAsync();
        Assert.Equal(["s1", "s2"], page.Entries.Select(entry => entry.Schedule.Id));
    });

    [Fact]
    public Task AWeeklyScheduleWithNoDaySendsNothingAndSaysSo() => Ui.Run(async () =>
    {
        var server = new Server(); using var workspace = await ConnectAsync(server);
        var page = new SchedulesPage(workspace, new Host());
        await page.InitializeAsync();
        var editor = page.OpenEditorForRender();
        editor.Prefill(nameText: "週", text: "まとめる", frequencyId: "weekly", weekdays: []);
        await editor.SaveAsync();
        Assert.Equal("曜日を選んでください。", editor.ErrorText);
        Assert.Empty(server.Sent);
        editor.Prefill(weekdays: [1, 3]);
        var body = editor.Collect(out var owner);
        Assert.Contains("* * 1,3", (string)body["expression"]!);
        Assert.Equal("ベル", owner.Name);
    });

    private static SecretRequest Request() => JsonSerializer.Deserialize<SecretRequest>("""{"id":"r1","botId":"b1","toolId":"t","label":"鍵","message":"入力してください","status":"pending"}""", BellApi.Json)!;

    [Fact]
    public Task ASecretIsSentOnceAndTheFieldIsEmptiedAtOnce() => Ui.Run(async () =>
    {
        SecretSubmission? sent = null; SecretRequest? done = null; var calls = 0;
        var window = new SecretInputWindow(Request(), submission => { calls++; sent = submission; return Task.FromResult(Request() with { Status = "submitted" }); }, () => Task.FromResult<OnePasswordKey[]?>(null), result => done = result);
        window.Input.Text = "top secret";
        await window.SubmitAsync(true);
        Assert.Equal(1, calls); Assert.Equal("top secret", sent!.Body["value"]);
        Assert.Equal("submitted", done!.Status);
        Assert.Equal("", window.Input.Text);
    });

    [Fact]
    public Task AFailedSecretShowsAFixedLineThatNeverCarriesTheValue() => Ui.Run(async () =>
    {
        var window = new SecretInputWindow(Request(), submission => throw new InvalidOperationException("top secret"), () => Task.FromResult<OnePasswordKey[]?>(null), _ => { });
        window.Input.Text = "top secret";
        await window.SubmitAsync(true);
        Assert.Equal("登録結果を確認できませんでした。閉じて最新の状態を確認してください。", window.ErrorText.Text);
        Assert.DoesNotContain("top secret", window.ErrorText.Text);
        Assert.Equal("", window.Input.Text);
    });
}
