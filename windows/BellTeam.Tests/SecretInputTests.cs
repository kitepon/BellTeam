using System.Net;
using System.Text.Json;
using System.Windows.Controls;
using BellTeam.App;
using BellTeam.Core;

namespace BellTeam.Tests;

// W-MAC 14: the secret input card (inputOptions, wording, one-time values, the 1Password list, the submit bodies).
public sealed class SecretInputTests
{
    private const string Available = """{"preferred":"onepassword","onePasswordAvailable":true}""";
    private static SecretRequest Request(string extra = "")
        => JsonSerializer.Deserialize<SecretRequest>("{\"id\":\"r1\",\"botId\":\"bot-a\",\"toolId\":\"t\",\"label\":\"鍵\",\"message\":\"入力してください\",\"status\":\"pending\"" + extra + "}", BellApi.Json)!;
    private static SecretRequest Terminal(string purpose, string options = Available) => Request($$""","purpose":"{{purpose}}","inputOptions":{{options}}""");
    private static OnePasswordKey Key(string title, string? vault, string reference) => new(title, vault, reference);
    private static readonly OnePasswordKey[] Items =
    [
        Key("Mac mini 本番", "Infra", "op://v/a/password"), Key("office-imac", "Infra", "op://v/b/password"), Key("個人用ノート PC", "Team", "op://v/c/password"),
        Key("スタジオ Mac", "Team", "op://v/d/password"), Key("deploy key", "Infra", "op://v/e/private key?ssh-format=openssh")
    ];

    [Fact]
    public void InputOptionsAndOneTimeAreReadLeniently()
    {
        Assert.Null(Request().InputOptions);
        Assert.False(Request().OnePasswordOffered);
        Assert.True(Request($$""","inputOptions":{{Available}}""").OnePasswordOffered);
        Assert.True(Request($$""","inputOptions":{{Available}}""").OpensWithOnePassword);
        Assert.False(Request(""","inputOptions":{"preferred":"stored","onePasswordAvailable":true}""").OpensWithOnePassword);
        Assert.True(Request(""","inputOptions":{"preferred":"stored","onePasswordAvailable":true}""").OnePasswordOffered);
        // A value of the wrong type reads as absent and never fails the whole history.
        foreach (var odd in new[] { "5", "\"yes\"", "[]", "null", "{\"onePasswordAvailable\":\"true\"}", "{}" })
            Assert.False(Request($$""","inputOptions":{{odd}}""").OnePasswordOffered);
        Assert.True(Request(""","oneTime":true""").OneTime);
        foreach (var odd in new[] { "false", "\"true\"", "1", "null", "{}" }) Assert.False(Request($$""","oneTime":{{odd}}""").OneTime);
    }

    [Fact]
    public void ChoiceWordingNamesOnlyWhereTheValueComesFrom()
    {
        var ssh = new SecretInputModel(Terminal("terminal.ssh"));
        Assert.True(ssh.Picker); Assert.True(ssh.UseOnePassword);
        Assert.Equal(("1Passwordから選ぶ", "ここに貼り付ける"), (ssh.OnePasswordChoice, ssh.InputChoice));
        var sudo = new SecretInputModel(Terminal("terminal.sudo"));
        Assert.Equal(("1Passwordから選ぶ", "ここに入力する"), (sudo.OnePasswordChoice, sudo.InputChoice));
        // A card with no list is an op:// reference field.
        var reference = new SecretInputModel(Request($$""","inputOptions":{{Available}}"""));
        Assert.False(reference.Picker);
        Assert.Equal(("1Passwordから読み出す", "ここに入力する"), (reference.OnePasswordChoice, reference.InputChoice));
        foreach (var model in new[] { ssh, sudo, reference })
        {
            Assert.Equal("登録して続ける", model.SubmitLabel);
            Assert.DoesNotContain("保存", model.OnePasswordChoice + model.InputChoice); Assert.DoesNotContain("登録", model.OnePasswordChoice + model.InputChoice);
        }
        // Only the note says whether the value is kept.
        Assert.Contains("使うときに1Passwordから読み出します", ssh.Note);
        ssh.UseOnePassword = false; Assert.Contains("会話に送信されません", ssh.Note);
        sudo.UseOnePassword = false; Assert.Contains("BellTeamの利用者領域へ保存します", sudo.Note);
        // The server prefers the stored input: that choice is the default and 1Password stays below it.
        var stored = new SecretInputModel(Terminal("terminal.sudo", """{"preferred":"stored","onePasswordAvailable":true}"""));
        Assert.False(stored.UseOnePassword); Assert.True(stored.ChoicesShown);
        // An older body (no inputOptions) is the input field only.
        var old = new SecretInputModel(Request());
        Assert.False(old.ChoicesShown); Assert.False(old.UseOnePassword);
    }

    [Fact]
    public void OneTimeValuesNeverOfferOnePasswordOrSayTheyAreSaved()
    {
        var oneTime = new SecretInputModel(Request($$""","oneTime":true,"inputOptions":{{Available}}"""));
        Assert.False(oneTime.ChoicesShown); Assert.False(oneTime.UseOnePassword); Assert.False(oneTime.Picker);
        Assert.Equal("渡して続ける", oneTime.SubmitLabel);
        Assert.Equal("1回だけ使い、使い終わったら消します。保存せず、会話にも送られません。", oneTime.Note);
        var login = new SecretInputModel(Terminal("terminal.login"));
        Assert.False(login.ChoicesShown); Assert.False(login.UseOnePassword);
        Assert.Equal("パスワードを渡す", login.SubmitLabel);
        Assert.Equal("このMacのログインパスワード（1回だけ使い、保存しません）", login.Note);
        Assert.DoesNotContain("登録", oneTime.SubmitLabel + login.SubmitLabel);
    }

    [Fact]
    public void SubmitBodiesAreTheValueOrAnOnePasswordReference()
    {
        Assert.Equal(new Dictionary<string, string> { ["value"] = "a\nb " }, SecretSubmission.Value("a\nb ").Body);
        Assert.Equal(new Dictionary<string, string> { ["source"] = "onepassword", ["reference"] = "op://v/i/f" }, SecretSubmission.OnePassword(" op://v/i/f ").Body);
        Assert.Null(SecretSubmission.ReferenceProblem(" op://v/i/f"));
        Assert.Equal("1Passwordの参照（op://で始まる）を入力してください。", SecretSubmission.ReferenceProblem("https://example.com"));
        Assert.Equal("1Passwordの参照（op://で始まる）を入力してください。", SecretSubmission.ReferenceProblem(""));
    }

    [Theory]
    [InlineData("submit", "{\"source\":\"onepassword\",\"reference\":\"op://v/i/f\"}")]
    [InlineData("cancel", "{}")]
    public async Task TheCardPostsTheBodyToTheSecretRoute(string action, string expected)
    {
        using var api = new BellApi(new("http://localhost/"), new StubHandler(async (request, token) =>
        {
            Assert.Equal($"/api/secret-requests/r1/{action}", request.RequestUri!.AbsolutePath);
            Assert.Equal(expected, await request.Content!.ReadAsStringAsync(token));
            return StubHandler.Json("""{"request":{"id":"r1","botId":"bot-a","toolId":"t","label":"鍵","message":"m","status":"submitted"}}""");
        }));
        await api.FinishSecretAsync("r1", action == "submit" ? SecretSubmission.OnePassword("op://v/i/f") : null);
    }

    [Fact]
    public void SudoKeepsOnlyPasswordReferencesAndTheSearchMatchesTitleOrVaultIgnoringCase()
    {
        var sudo = new SecretInputModel(Terminal("terminal.sudo")); sudo.KeysLoaded(Items);
        Assert.Equal(4, sudo.Shown.Length); Assert.DoesNotContain(sudo.Shown, key => key.Title == "deploy key");
        Assert.Equal("4件から選んでください", sudo.CountLine);
        sudo.SetSearch("team"); Assert.Equal(["個人用ノート PC", "スタジオ Mac"], sudo.Shown.Select(key => key.Title));
        sudo.SetSearch("  OFFICE "); Assert.Equal(["office-imac"], sudo.Shown.Select(key => key.Title));
        sudo.SetSearch("該当なし"); Assert.Empty(sudo.Shown); Assert.Equal("「該当なし」に合うパスワードがありません", sudo.CountLine);
        var ssh = new SecretInputModel(Terminal("terminal.ssh")); ssh.KeysLoaded(Items);
        Assert.Equal(5, ssh.Shown.Length);
        ssh.SetSearch("infra"); Assert.Equal(3, ssh.Shown.Length);
        ssh.SetSearch("zzz"); Assert.Equal("「zzz」に合う鍵がありません", ssh.CountLine);
    }

    [Fact]
    public void ASelectionTheSearchNoLongerShowsIsCleared()
    {
        var sudo = new SecretInputModel(Terminal("terminal.sudo")); sudo.KeysLoaded(Items);
        sudo.Reference = "op://v/c/password";
        sudo.SetSearch("team"); Assert.Equal("op://v/c/password", sudo.Reference);
        sudo.SetSearch("infra"); Assert.Equal("", sudo.Reference);
        Assert.False(sudo.Ready(""));
    }

    [Fact]
    public async Task AnOlderBodyWithoutTheListFallsBackToTheInputField()
    {
        using var old = new BellApi(new("http://localhost/"), new StubHandler((request, _) =>
        {
            Assert.Equal("/api/secret-requests/r%201/onepassword-items", request.RequestUri!.AbsolutePath);
            return Task.FromResult(StubHandler.Json("""{"error":"NOT_FOUND"}""", HttpStatusCode.NotFound));
        }));
        Assert.Null(await new SecretRequestApi(old).KeysAsync("r 1"));
        var ssh = new SecretInputModel(Terminal("terminal.ssh"));
        Assert.True(ssh.Picker);
        ssh.KeysLoaded(null);
        Assert.False(ssh.Picker); Assert.False(ssh.ChoicesShown); Assert.False(ssh.UseOnePassword);
        Assert.Equal("この版のサーバーには1Passwordの鍵の一覧がありません。鍵を貼り付けて保存してください。", ssh.UnsupportedLine);
        // Any other failure is shown, not turned into the input field.
        using var broken = new BellApi(new("http://localhost/"), new StubHandler((_, _) => Task.FromResult(StubHandler.Json("""{"error":"BOOM"}""", HttpStatusCode.InternalServerError))));
        await Assert.ThrowsAsync<BellApiException>(() => new SecretRequestApi(broken).KeysAsync("r1"));
        using var listed = new BellApi(new("http://localhost/"), new StubHandler((_, _) => Task.FromResult(StubHandler.Json("""{"items":[{"title":"infra","vault":"Infra","reference":"op://v/i/private key"},{"title":"no vault","reference":"op://v/j/f"}]}"""))));
        Assert.Equal([Key("infra", "Infra", "op://v/i/private key"), Key("no vault", null, "op://v/j/f")], (await new SecretRequestApi(listed).KeysAsync("r1"))!);
    }

    [Fact]
    public void TheSshCardPicksFromTheListSearchesAndSendsOnlyTheReference()
    {
        RunSta(() =>
        {
            SecretSubmission? sent = null;
            var window = new SecretInputWindow(Terminal("terminal.ssh"), submission => { sent = submission; return Task.FromResult(Request()); }, () => Task.FromResult<OnePasswordKey[]?>(Items), _ => { });
            window.KeysReady.GetAwaiter().GetResult();
            var rows = () => LogicalTree.Find<RadioButton>(window.Content).Where(radio => radio.GroupName == "keys").ToArray();
            Assert.Equal(5, rows().Length);
            window.SearchForRender("zzz"); Assert.Empty(rows());
            window.SearchForRender("INFRA"); Assert.Equal(3, rows().Length);
            rows()[1].IsChecked = true;
            // Searching again drops a choice that is no longer listed.
            window.SearchForRender("mini"); Assert.DoesNotContain(rows(), row => row.IsChecked == true);
            window.SearchForRender("infra"); rows()[1].IsChecked = true;
            window.SubmitAsync(true).GetAwaiter().GetResult();
            Assert.Equal(new Dictionary<string, string> { ["source"] = "onepassword", ["reference"] = "op://v/b/password" }, sent!.Body);
        });
    }

    [Fact]
    public void ThePastedKeyKeepsItsNewlinesAndTheFieldsAreEmptiedAfterSending()
    {
        RunSta(() =>
        {
            SecretSubmission? sent = null;
            // 1Password is not connected: the key is pasted into a multi-line field.
            var window = new SecretInputWindow(Terminal("terminal.ssh", """{"preferred":"onepassword","onePasswordAvailable":false}"""), submission => { sent = submission; return Task.FromResult(Request()); }, () => throw new InvalidOperationException(), _ => { });
            Assert.True(window.Paste.AcceptsReturn);
            window.Paste.Text = "-----BEGIN-----\nline\n-----END-----\n";
            window.SubmitAsync(true).GetAwaiter().GetResult();
            Assert.Equal("-----BEGIN-----\nline\n-----END-----\n", sent!.Body["value"]);
            Assert.Equal("", window.Paste.Text);
        });
    }

    [Fact]
    public void ARejectedReferenceIsNotSent()
    {
        RunSta(() =>
        {
            var sent = false;
            var window = new SecretInputWindow(Request($$""","inputOptions":{{Available}}"""), _ => { sent = true; return Task.FromResult(Request()); }, () => throw new InvalidOperationException(), _ => { });
            window.Reference.Text = "https://example.com";
            window.SubmitAsync(true).GetAwaiter().GetResult();
            Assert.False(sent); Assert.Equal("1Passwordの参照（op://で始まる）を入力してください。", window.ErrorText.Text);
        });
    }

    private static void RunSta(Action action)
    {
        Exception? failure = null; var thread = new Thread(() => { try { action(); } catch (Exception error) { failure = error; } });
        thread.SetApartmentState(ApartmentState.STA); thread.Start(); thread.Join();
        if (failure is not null) System.Runtime.ExceptionServices.ExceptionDispatchInfo.Capture(failure).Throw();
    }
}
