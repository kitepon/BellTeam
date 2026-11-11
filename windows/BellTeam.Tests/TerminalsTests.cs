using System.Net;
using System.Net.Http;
using System.Text.Json;
using System.Windows.Threading;
using BellTeam.App;
using BellTeam.Core;

namespace BellTeam.Tests;

// W-MAC 16a: settings 「端末」 (decode, key rows, reason texts per OS, the draft and fingerprint rules, list read outcomes, key requests, the key authorization).
public sealed class TerminalsTests
{
    private const string Full = """{"terminalId":"studio-mac","host":"192.168.1.30","user":"hana","port":2222,"os":"linux","accountOwner":"terminal-owner","sshKeyConfigured":true,"sudoKeyConfigured":true,"hostTrust":{"trustRevision":3},"keySource":"terminal-native","sudoKeySource":"secret","sshKeyPending":false,"sudoKeyPending":true,"keyAuthorizationPending":true,"keyAuthorization":{"requestId":"r1","outcome":"AUTHORIZED","observedAt":"2026-11-10T01:00:00Z"},"maintenance":{"observedAt":"2026-11-09T03:00:00Z","before":"2.1.30","after":"2.1.32","outcome":"updated"}}""";
    private static Terminal Read(string json) => JsonSerializer.Deserialize<Terminal>(json, BellApi.Json)!;
    private static TerminalCheck Check(string reason, string? action = null, bool reachable = false) => new() { TerminalId = "t", Reachable = reachable, Reason = reason, Action = action };

    [Fact]
    public void ATerminalReadsEveryProjectionFieldAndDefaultsTheMissingOnes()
    {
        var full = Read(Full);
        Assert.Equal(("studio-mac", "192.168.1.30", "hana", 2222, "linux", "terminal-owner"), (full.TerminalId, full.Host, full.User, full.Port, full.Os, full.AccountOwner));
        Assert.True(full.HostTrusted); Assert.True(full.KeysRouteAvailable); Assert.True(full.SudoKeyPending); Assert.True(full.KeyAuthorizationPending);
        Assert.Equal(new KeyAuthorization("r1", "AUTHORIZED", "2026-11-10T01:00:00Z"), full.KeyAuthorization);
        Assert.Equal("Claude Codeを更新しました（2.1.30 → 2.1.32）", full.Maintenance!.Text);
        Assert.Equal(("hana@192.168.1.30:2222", "Linux", "その端末の持ち主"), (full.Address, full.OsLabel, full.OwnerLabel));
        // An older body: only the id is certain; everything else has the Mac's default and there is no keys route.
        var old = Read("""{"terminalId":"a"}""");
        Assert.Equal(("", "", 22, "macos", "owner", false, false), (old.Host, old.User, old.Port, old.Os, old.AccountOwner, old.HostTrusted, old.KeysRouteAvailable));
        Assert.Equal(("macOS", "自分の端末"), (old.OsLabel, old.OwnerLabel));
        Assert.Equal("Windows", Read("""{"terminalId":"a","os":"windows"}""").OsLabel); Assert.Equal("freebsd", Read("""{"terminalId":"a","os":"freebsd"}""").OsLabel);
    }

    [Fact]
    public void OddShapesOfTheOptionalObjectsReadAsNoneAndAWrongTypeIsAFailedRead()
    {
        foreach (var odd in new[] { "5", "\"x\"", "[]", "null", "{\"observedAt\":3}" })
        {
            var terminal = Read($$"""{"terminalId":"a","hostTrust":{{odd}},"maintenance":{{odd}},"keyAuthorization":{{odd}}}""");
            Assert.Null(terminal.Maintenance); Assert.Null(terminal.KeyAuthorization);
            if (odd != "{\"observedAt\":3}") Assert.False(terminal.HostTrusted);
        }
        Assert.True(Read("""{"terminalId":"a","hostTrust":{}}""").HostTrusted);
        Assert.ThrowsAny<JsonException>(() => Read("""{"terminalId":"a","port":"22"}"""));
        Assert.ThrowsAny<JsonException>(() => Read("""{"terminalId":"a","host":5}"""));
        Assert.ThrowsAny<JsonException>(() => Read("""{"host":"h"}"""));
    }

    [Fact]
    public void MaintenanceWordsTheLastUpkeepOutcome()
    {
        Assert.Equal("Claude Codeは最新です（2.1.32）", new TerminalMaintenance(null, null, "2.1.32", "current").Text);
        Assert.Equal("Claude Codeは最新です", new TerminalMaintenance(null, null, null, "current").Text);
        Assert.Equal("Claude Codeを更新しました", new TerminalMaintenance(null, null, null, "updated").Text);
        Assert.Equal("Claude Codeを更新しました（2.1.30 → -）", new TerminalMaintenance(null, "2.1.30", null, "updated").Text);
        Assert.Equal("Claude Codeを更新できませんでした。入っている版のまま使います", new TerminalMaintenance(null, null, null, "failed").Text);
        Assert.Equal("Claude Codeの更新結果を読み取れませんでした", new TerminalMaintenance(null, null, null, null).Text);
    }

    [Fact]
    public void KeyRowsSayTheirStateAndWhereTheKeyIs()
    {
        // An older BellTeam has no pending fields: no buttons, one line.
        var old = Read("""{"terminalId":"a","sshKeyConfigured":true}""").Key(TerminalKeyKind.Ssh);
        Assert.Equal(TerminalKeyStatus.Unsupported, old.Status); Assert.Equal("このBellTeamはまだアプリからの鍵の設定に対応していません", old.Text); Assert.False(old.Removable);
        TerminalKeyState Row(string fields, TerminalKeyKind kind = TerminalKeyKind.Ssh) => Read($$"""{"terminalId":"a","sshKeyPending":false,"sudoKeyPending":false,{{fields}}}""").Key(kind);
        var missing = Row("\"sshKeyConfigured\":false");
        Assert.Equal(("未設定", "設定する", false, null), (missing.Text, missing.SetTitle, missing.Removable, missing.SourceText));
        var native = Row("\"sshKeyConfigured\":true,\"keySource\":\"terminal-native\"");
        Assert.Equal(("設定済み", "設定し直す", true, "端末にある鍵"), (native.Text, native.SetTitle, native.Removable, native.SourceText));
        Assert.Equal("BellTeamに預けた鍵", Row("\"sshKeyConfigured\":true,\"keySource\":\"secret\"").SourceText);
        Assert.Equal("BellTeamに預けた鍵", Row("\"sudoKeyConfigured\":true,\"sudoKeySource\":\"secret\"", TerminalKeyKind.Sudo).SourceText);
        // A card was opened and nothing is bound yet: a key already in use stays in use and keeps its source.
        var first = Row("\"sshKeyConfigured\":false,\"sshKeyPending\":true");
        Assert.Equal(("設定待ち", "設定する", true, null), (first.Text, first.SetTitle, first.Removable, first.SourceText));
        var again = Row("\"sshKeyConfigured\":true,\"keySource\":\"terminal-native\",\"sshKeyPending\":true");
        Assert.Equal(("設定待ち", "設定し直す", true, "端末にある鍵"), (again.Text, again.SetTitle, again.Removable, again.SourceText));
        Assert.Equal(["SSH鍵", "sudo鍵"], new[] { TerminalKeyKind.Ssh, TerminalKeyKind.Sudo }.Select(TerminalKeyKinds.Title));
        Assert.True(TerminalOS.UsesSudoKey("macos")); Assert.True(TerminalOS.UsesSudoKey("linux")); Assert.False(TerminalOS.UsesSudoKey("windows"));
    }

    [Theory]
    [InlineData("macos", "Macが接続を断りました。Macの「システム設定 > 一般 > 共有」で「リモートログイン」がオンか確かめてください。", "この鍵がまだMacに入っていないかもしれません。", "Macが届きませんでした。Macが起きていて、同じネットワークにあるか確かめてください。起きれば自動で再開します。")]
    [InlineData("windows", "Windows PCが接続を断りました。Windowsの「設定 > システム > オプション機能」でOpenSSH サーバーを追加し、sshdサービスを開始してください。", "この鍵がまだWindows PCに入っていないかもしれません。", "Windows PCが届きませんでした。Windows PCが起きていて、同じネットワークにあるか確かめてください。起きれば自動で再開します。")]
    [InlineData("linux", "Linuxマシンが接続を断りました。Linuxにopenssh-serverを入れて、sshdを開始してください（systemctl enable --now ssh）。", "この鍵がまだLinuxマシンに入っていないかもしれません。", "Linuxマシンが届きませんでした。Linuxマシンが起きていて、同じネットワークにあるか確かめてください。起きれば自動で再開します。")]
    public void ReasonsAreWordedPerOsAndNameTheLikelyFix(string os, string refused, string authFailed, string unreachable)
    {
        Assert.Equal(refused, Check("CONNECTION_REFUSED").Explanation(os));
        Assert.Equal(authFailed, Check("AUTH_FAILED").Explanation(os));
        Assert.Equal(unreachable, Check("UNREACHABLE").Explanation(os));
        // The other unreachable reasons do not name the OS; a reachable result has no sentence.
        Assert.Equal("端末が眠っているか、ネットワークで届きません。端末が起きれば自動で再開します。", Check("CONNECTION_LOST").Explanation(os));
        Assert.Null(Check("", reachable: true).Explanation(os));
    }

    [Fact]
    public void TheServerActionWinsAndIsNotShownTwice()
    {
        var refused = Check("CONNECTION_REFUSED", "  Windowsのサーバー文  ");
        Assert.Equal("Windowsのサーバー文", refused.Explanation("windows")); Assert.Null(refused.ExtraAction);
        Assert.Equal("サーバー文", Check("AUTH_FAILED", "サーバー文").Explanation()); Assert.Null(Check("AUTH_FAILED", "サーバー文").ExtraAction);
        // A blank action is no action; for the other reasons the action is a second line.
        Assert.Equal("この鍵がまだMacに入っていないかもしれません。", Check("AUTH_FAILED", "  ").Explanation());
        var other = Check("UNREACHABLE", "起こしてください"); Assert.Equal("起こしてください", other.ExtraAction); Assert.StartsWith("Macが届きませんでした。", other.Explanation());
        Assert.Null(Check("UNREACHABLE").ExtraAction);
        Assert.Equal("つながる", Check("", reachable: true).Summary); Assert.Equal("つながらない", Check("X").Summary);
    }

    [Theory]
    [InlineData("CONNECTION_REFUSED", TerminalCheck.ProblemKind.Refused)]
    [InlineData("AUTH_FAILED", TerminalCheck.ProblemKind.AuthFailed)]
    [InlineData("UNREACHABLE", TerminalCheck.ProblemKind.Unreachable)]
    [InlineData("TERMINAL_UNAVAILABLE", TerminalCheck.ProblemKind.Unreachable)]
    [InlineData("CONNECTION_LOST", TerminalCheck.ProblemKind.Unreachable)]
    [InlineData("REMOTE_AITERM_UNAVAILABLE", TerminalCheck.ProblemKind.Unreachable)]
    [InlineData("CREDENTIAL_UNAVAILABLE", TerminalCheck.ProblemKind.Credential)]
    [InlineData("SSH_KEY_UNSET", TerminalCheck.ProblemKind.Credential)]
    [InlineData("CREDENTIAL_REQUIRED", TerminalCheck.ProblemKind.Credential)]
    [InlineData("TARGET_MISMATCH", TerminalCheck.ProblemKind.HostKey)]
    [InlineData("HOST_TRUST_MISSING", TerminalCheck.ProblemKind.HostKey)]
    [InlineData("HOST_KEY_MISMATCH", TerminalCheck.ProblemKind.HostKey)]
    [InlineData("TERMINAL_NOT_FOUND", TerminalCheck.ProblemKind.NotFound)]
    [InlineData("SOMETHING_ELSE", TerminalCheck.ProblemKind.Other)]
    public void ReasonCodesSortIntoTheKindsOfProblem(string reason, TerminalCheck.ProblemKind kind)
    {
        Assert.Equal(kind, Check(reason).Problem);
        Assert.Equal(kind == TerminalCheck.ProblemKind.AuthFailed, Check(reason).OffersAuthorize);
        Assert.Null(Check(reason, reachable: true).Problem);
    }

    private const string Fingerprint = "SHA256:nsffMHVAtGXV6+uEQqXTTMcNxrINQqErir/1ZI1Ch/Y";

    [Fact]
    public void AFingerprintIsSha256AndFortyThreeCharactersAndOnlyAHostKeyReasonOffersTheSheet()
    {
        Assert.Equal(43, Fingerprint.Length - 7); Assert.Null(HostKeyFingerprint.Problem(Fingerprint)); Assert.Null(HostKeyFingerprint.Problem("  " + Fingerprint + "\n"));
        Assert.Equal("端末で読んだ指紋を入れてください。", HostKeyFingerprint.Problem("  "));
        var form = "指紋は「SHA256:」で始まり、続けて43文字です。端末に表示されたとおりに入れてください。";
        foreach (var bad in new[] { Fingerprint[..^1], Fingerprint + "A", Fingerprint[7..], Fingerprint.Replace("SHA256", "SHA1"), "SHA256:" + new string('=', 43), Fingerprint[..20] + " " + Fingerprint[20..], Fingerprint[..20] + "\n" + Fingerprint[20..] })
            Assert.Equal(form, HostKeyFingerprint.Problem(bad));
        Assert.Equal(Fingerprint, Check("TARGET_MISMATCH", $"confirm the new host key {Fingerprint} on office-imac.local").ReportedFingerprint);
        Assert.Null(Check("TARGET_MISMATCH", "confirm the new host key").ReportedFingerprint); Assert.Null(Check("TARGET_MISMATCH").ReportedFingerprint);
        Assert.Equal(TerminalCheck.ProblemKind.HostKey, Check("HOST_TRUST_STALE").Problem);
    }

    [Fact]
    public void TheDraftIsCheckedTheWayTheServerChecksIt()
    {
        TerminalDraft Draft(string id = "owner-macbook", string host = "192.168.1.12", string user = "kite", string port = "22") => new() { TerminalId = id, Host = host, User = user, Port = port };
        Assert.Empty(Draft().Problems(true));
        // The id is only checked when new; it is lower case letters, digits and hyphens, at most 63, starting with a letter or digit.
        foreach (var bad in new[] { "", "Owner", "-a", "a_b", "a b", new string('a', 64), "a\n" }) Assert.Contains(TerminalField.TerminalId, Draft(id: bad).Problems(true).Keys);
        Assert.Empty(Draft(id: "").Problems(false)); Assert.Empty(Draft(id: new string('a', 63)).Problems(true)); Assert.Empty(Draft(id: "0a-b").Problems(true));
        foreach (var good in new[] { "192.168.1.12", "office-imac.local", "fe80::1", "::1", "a" }) Assert.Empty(Draft(host: good).Problems(true));
        foreach (var bad in new[] { "", "kite@host", "host:22x", "host/path", "-host", "host-", "host name", new string('a', 254), "a\n" }) Assert.Contains(TerminalField.Host, Draft(host: bad).Problems(true).Keys);
        foreach (var good in new[] { "kite", "kite_", "_svc", "Kite.Lee-2", "svc$" }) Assert.Empty(Draft(user: good).Problems(true));
        foreach (var bad in new[] { "", "1kite", "ki te", "kite@", "kite\n" }) Assert.Contains(TerminalField.User, Draft(user: bad).Problems(true).Keys);
        foreach (var good in new[] { "1", "22", "65535" }) Assert.Empty(Draft(port: good).Problems(true));
        foreach (var bad in new[] { "", "0", "65536", "-1", "22.5", "٢٢", " 22", "123456" }) Assert.Contains(TerminalField.Port, Draft(port: bad).Problems(true).Keys);
        Assert.Equal("端末IDは英小文字・数字・ハイフンで、先頭は英小文字か数字です（例 owner-macbook）。", Draft(id: "X").Problems(true)[TerminalField.TerminalId]);
        Assert.Equal("ポートは1から65535の数字です（ふつうは22）。", Draft(port: "0").Problems(true)[TerminalField.Port]);
    }

    [Fact]
    public void TheDraftSendsTheOsItWasReadWithAndNeverTheKeys()
    {
        var windows = Read("""{"terminalId":"fox","host":"192.168.1.11","user":"kite_","port":22,"os":"windows","accountOwner":"terminal-owner","sshKeyConfigured":true}""");
        var edit = new TerminalDraft(windows);
        Assert.Equal("""{"host":"192.168.1.11","user":"kite_","port":22,"os":"windows","accountOwner":"terminal-owner"}""", JsonSerializer.Serialize(edit.Body, BellApi.Json));
        // A new draft is the Mac's default (macOS, your own terminal, port 22); an unknown os read from the server is sent back as read.
        Assert.Equal("""{"host":"","user":"","port":22,"os":"macos","accountOwner":"owner"}""", JsonSerializer.Serialize(new TerminalDraft().Body, BellApi.Json));
        Assert.Equal("freebsd", new TerminalDraft(Read("""{"terminalId":"a","os":"freebsd"}""")).Os);
        Assert.Equal(["macos", "windows", "linux"], TerminalOS.All); Assert.Equal(["macOS", "Windows", "Linux"], TerminalOS.All.Select(TerminalOS.Label));
    }

    // ---- HTTP: a stub registry that records what was sent ----
    private sealed class Wire
    {
        public readonly List<string> Calls = [];
        public readonly List<string> Bodies = [];
        public Func<string, string, HttpResponseMessage> Answer = (_, _) => StubHandler.Json("{}");
        // When set, a check is answered only after it is released, so two presses can overlap.
        public Task? HoldChecks;
        private async Task<HttpResponseMessage> RecordAsync(HttpRequestMessage request)
        {
            Calls.Add($"{request.Method} {request.RequestUri!.AbsolutePath}"); Bodies.Add(request.Content is null ? "" : await request.Content.ReadAsStringAsync());
            if (HoldChecks is not null && request.RequestUri.AbsolutePath.EndsWith("/check", StringComparison.Ordinal)) await HoldChecks;
            return Answer(request.Method.Method, request.RequestUri.AbsolutePath);
        }
        public BellApi Api() => new(new("http://localhost/"), new StubHandler((request, _) => RecordAsync(request)));
        // A workspace whose terminals answer from here and whose other reads are the usual fixtures.
        public Workspace Workspace() => new(origin => new BellApi(origin, new StubHandler((request, _) => request.RequestUri!.AbsolutePath.StartsWith("/api/terminals", StringComparison.Ordinal) ? RecordAsync(request)
            : Task.FromResult(StubHandler.Json(request.RequestUri.AbsolutePath switch { "/api/session" => """{"authenticated":true,"authMode":"local"}""", "/api/bots" => ApiTests.Bots, "/api/rooms" => ApiTests.Rooms, "/api/queue" => ApiTests.EmptyQueue, "/api/owner" => ApiTests.Owner, _ => ApiTests.Page })))));
    }
    private static HttpResponseMessage Error(HttpStatusCode status, string code, string? message = null) => StubHandler.Json(JsonSerializer.Serialize(new { error = code, message }), status);
    private static string List(params string[] terminals) => "{\"terminals\":[" + string.Join(",", terminals) + "]}";
    private const string Mini = """{"terminalId":"mini","host":"192.168.1.40","user":"kite","sshKeyConfigured":true,"sudoKeyConfigured":false,"sshKeyPending":false,"sudoKeyPending":false,"hostTrust":{"trustRevision":1}}""";

    [Theory]
    [InlineData(HttpStatusCode.NotFound)]
    [InlineData(HttpStatusCode.MethodNotAllowed)]
    public async Task ANeverReadListThatAnswers404Or405IsAnOlderBodyAndNotAFailure(HttpStatusCode status)
    {
        var wire = new Wire { Answer = (_, _) => Error(status, "NOT_FOUND") }; using var api = wire.Api();
        var model = new TerminalsModel(new TerminalsApi(api));
        await model.RefreshAsync();
        Assert.Equal(TerminalListState.Unsupported, model.State); Assert.Null(model.FailedMessage); Assert.False(model.Loading); Assert.Equal(["GET /api/terminals"], wire.Calls);
    }

    [Fact]
    public async Task A503TerminalsUnavailableIsAFailureAndAfterAGoodReadItKeepsTheRoster()
    {
        var wire = new Wire { Answer = (_, _) => Error(HttpStatusCode.ServiceUnavailable, "TERMINALS_UNAVAILABLE", "terminals are not running") }; using var api = wire.Api();
        var model = new TerminalsModel(new TerminalsApi(api));
        await model.RefreshAsync();
        Assert.Equal(TerminalListState.Failed, model.State); Assert.Equal("端末の機能が、いま本体で動いていません。少し待ってから、もう一度読み込んでください。", model.FailedMessage); Assert.Empty(model.Terminals);
        // The retry is the Owner's press; a good answer replaces the failure.
        wire.Answer = (_, _) => StubHandler.Json(List(Mini)); await model.RefreshAsync();
        Assert.Equal(TerminalListState.Supported, model.State); Assert.Null(model.FailedMessage); Assert.Equal(["mini"], model.Terminals.Select(item => item.TerminalId));
        // A later 503, and even a later 404, keep what was read and say why they are not newer.
        foreach (var later in new[] { Error(HttpStatusCode.ServiceUnavailable, "TERMINALS_UNAVAILABLE"), Error(HttpStatusCode.NotFound, "NOT_FOUND") })
        {
            wire.Answer = (_, _) => later; await model.RefreshAsync();
            Assert.Equal(TerminalListState.Supported, model.State); Assert.Equal(["mini"], model.Terminals.Select(item => item.TerminalId)); Assert.NotNull(model.ReadError);
        }
        wire.Answer = (_, _) => StubHandler.Json(List(Mini)); await model.RefreshAsync(); Assert.Null(model.ReadError);
        Assert.All(wire.Calls, call => Assert.Equal("GET /api/terminals", call));
    }

    [Fact]
    public async Task OnlyTheNewestReadWritesTheList()
    {
        var gate = new TaskCompletionSource(); var first = true;
        using var api = new BellApi(new("http://localhost/"), new StubHandler(async (_, _) => { if (first) { first = false; await gate.Task; return StubHandler.Json(List()); } return StubHandler.Json(List(Mini)); }));
        var model = new TerminalsModel(new TerminalsApi(api));
        var slow = model.RefreshAsync(); await model.RefreshAsync(); gate.SetResult(); await slow;
        Assert.Equal(["mini"], model.Terminals.Select(item => item.TerminalId)); Assert.False(model.Loading);
    }

    [Fact]
    public async Task ASaveSendsOnePutAndTheListFollowsTheAnswerAndAFailureIsNotResent()
    {
        var wire = new Wire { Answer = (method, _) => method == "GET" ? StubHandler.Json(List(Mini)) : StubHandler.Json(Mini.Replace("192.168.1.40", "192.168.1.41")) }; using var api = wire.Api();
        var model = new TerminalsModel(new TerminalsApi(api)); await model.RefreshAsync();
        model.Checks["mini"] = Check("AUTH_FAILED");
        var draft = new TerminalDraft(model.Find("mini")!) { Host = "192.168.1.41" };
        var saved = await model.SaveAsync("mini", draft);
        Assert.Equal("192.168.1.41", model.Find("mini")!.Host); Assert.Equal(saved, model.Find("mini")); Assert.False(model.Checks.ContainsKey("mini"));
        Assert.Equal(["GET /api/terminals", "PUT /api/terminals/mini"], wire.Calls); Assert.Equal("""{"host":"192.168.1.41","user":"kite","port":22,"os":"macos","accountOwner":"owner"}""", wire.Bodies[1]);
        wire.Answer = (_, _) => Error(HttpStatusCode.BadRequest, "INVALID_TERMINAL", "host must be an IP address or a host name");
        var error = await Assert.ThrowsAsync<BellApiException>(() => model.SaveAsync("mini", draft));
        Assert.Equal("ホストの形が違います。IPアドレスかホスト名だけを入れてください。", TerminalErrorText.Message(error)); Assert.Equal(3, wire.Calls.Count);
        // The host key is confirmed through the same PUT with only the typed fingerprint.
        wire.Answer = (_, _) => StubHandler.Json(Mini); await model.ConfirmHostKeyAsync("mini", "  " + Fingerprint + " ");
        using (var body = JsonDocument.Parse(wire.Bodies[^1])) Assert.Equal([("confirmHostKey", Fingerprint)], body.RootElement.EnumerateObject().Select(field => (field.Name, field.Value.GetString()!)));
        Assert.Equal("PUT /api/terminals/mini", wire.Calls[^1]);
    }

    [Fact]
    public async Task ARemovalDeletesOnceAndForgetsTheTerminal()
    {
        var wire = new Wire { Answer = (method, _) => method == "GET" ? StubHandler.Json(List(Mini)) : new HttpResponseMessage(HttpStatusCode.NoContent) }; using var api = wire.Api();
        var model = new TerminalsModel(new TerminalsApi(api)); await model.RefreshAsync(); model.Checks["mini"] = Check("X");
        await model.RemoveAsync("mini");
        Assert.Empty(model.Terminals); Assert.Empty(model.Checks); Assert.Equal(["GET /api/terminals", "DELETE /api/terminals/mini"], wire.Calls);
    }

    [Fact]
    public void ErrorCodesBecomePlainSentencesAndNeverEchoTheServersEnglish()
    {
        BellApiException Fail(HttpStatusCode status, string code, string message = "english") => new("BellTeam: " + message, status, code);
        foreach (var (field, sentence) in new[] { ("host", "ホストの形が違います。IPアドレスかホスト名だけを入れてください。"), ("user", "ユーザーの形が違います。端末にログインする名前を入れてください。"), ("port", "ポートは1から65535の数字にしてください。"), ("terminalId", "端末IDは英小文字・数字・ハイフンにしてください。"), ("accountOwner", "端末の持ち主を選び直してください。"), ("other", "入力の形が違います。各欄を確かめてください。") })
            Assert.Equal(sentence, TerminalErrorText.Message(Fail(HttpStatusCode.BadRequest, "INVALID_TERMINAL", field + " is bad")));
        Assert.Equal("同じ端末IDがもう登録されています。別のIDにしてください。", TerminalErrorText.Message(Fail(HttpStatusCode.Conflict, "TERMINAL_EXISTS")));
        Assert.Equal("入れた指紋が端末の今のホスト鍵と一致しませんでした。信用し直していません。端末で指紋をもう一度確かめてください。", TerminalErrorText.Message(Fail(HttpStatusCode.Conflict, "HOST_KEY_FINGERPRINT_MISMATCH")));
        Assert.Equal("鍵の中身はこの画面から送りません。開いた入力欄だけに入れてください。", TerminalErrorText.Message(Fail(HttpStatusCode.BadRequest, "KEY_IN_REQUEST_REFUSED")));
        Assert.Equal("設定の途中で端末の接続先が変わりました。もう一度「設定する」を押してください。", TerminalErrorText.Message(Fail(HttpStatusCode.Conflict, "TERMINAL_CHANGED")));
        Assert.Equal("BellTeamが端末への接続を準備できませんでした。BellTeamのAitermを更新してから、もう一度試してください。", TerminalErrorText.Message(Fail(HttpStatusCode.ServiceUnavailable, "TERMINAL_UNAVAILABLE")));
        // An unknown code is the server's own message; a request whose result is not known says so.
        Assert.Equal("BellTeam: english", TerminalErrorText.Message(Fail(HttpStatusCode.BadRequest, "NEW_CODE")));
        Assert.StartsWith("操作の結果を確認できませんでした。", TerminalErrorText.Message(new HttpRequestException("down")));
        Assert.StartsWith("操作の結果を確認できませんでした。", TerminalErrorText.Message(Fail(HttpStatusCode.BadGateway, "NEW_CODE")));
        Assert.True(TerminalErrorText.IsKeysUnsupported(Fail(HttpStatusCode.NotFound, "NOT_FOUND"))); Assert.False(TerminalErrorText.IsKeysUnsupported(Fail(HttpStatusCode.NotFound, "TERMINAL_NOT_FOUND")));
    }

    // ---- keys: an empty POST, the card for the botless request the server returns ----
    private const string KeyCard = """{"secretRequest":{"id":"r9","label":"miniのSSH鍵","inputOptions":{"preferred":"onepassword","onePasswordAvailable":true},"purpose":"terminal.ssh","botId":null}}""";
    private static Wire KeyWire() => new() { Answer = (method, path) => method == "GET" ? StubHandler.Json(List(Mini)) : method == "DELETE" ? new HttpResponseMessage(HttpStatusCode.NoContent) : path.EndsWith("/keys/ssh", StringComparison.Ordinal) ? StubHandler.Json(KeyCard) : StubHandler.Json("{}") };

    [Fact]
    public async Task ASetKeyPostsAnEmptyBodyAndHandsBackABotlessRequestThatTheSecretWindowOpens()
    {
        var wire = KeyWire(); using var api = wire.Api();
        var model = new TerminalsModel(new TerminalsApi(api)); await model.RefreshAsync();
        var request = await model.RequestKeyAsync("mini", TerminalKeyKind.Ssh);
        // The keys route names only {id, label, inputOptions}; the rest of the request has the Mac's defaults.
        Assert.Null(request.BotId); Assert.Equal(("r9", "miniのSSH鍵", "terminal.ssh", "", "pending"), (request.Id, request.Label, request.Purpose, request.Message, request.Status)); Assert.True(request.OnePasswordOffered);
        Assert.Equal(["GET /api/terminals", "POST /api/terminals/mini/keys/ssh", "GET /api/terminals"], wire.Calls); Assert.Equal("{}", wire.Bodies[1]);
        // A Bot's request still reads as before.
        Assert.Equal("bot-a", JsonSerializer.Deserialize<SecretRequest>("""{"id":"r","botId":"bot-a","toolId":"t","label":"l","message":"m","status":"pending"}""", BellApi.Json)!.BotId);
        // The card the request opens: no Bot, a terminal-key purpose, and the key picker when 1Password is connected.
        var card = new SecretInputModel(request); Assert.True(card.Multiline); Assert.True(card.Picker); Assert.True(card.UseOnePassword);
        await model.RemoveKeyAsync("mini", TerminalKeyKind.Sudo);
        Assert.Equal(["DELETE /api/terminals/mini/keys/sudo", "GET /api/terminals"], wire.Calls[^2..]);
    }

    [Fact]
    public void TheDetailButtonsRequestTheKeyOpenTheSecretWindowAndNeverResend()
    {
        var wire = KeyWire(); var opened = new List<SecretRequest>();
        RunSta(() =>
        {
            using var workspace = wire.Workspace();
            Await(workspace.ConnectAsync("http://localhost/", listen: false)); Await(workspace.Terminals.RefreshAsync());
            var view = new TerminalDetailView(workspace, "mini", CancellationToken.None, (request, _) => opened.Add(request));
            Await(view.SetKeyAsync(TerminalKeyKind.Ssh));
            // Removing goes through the confirmation first; the row is only sent once it is confirmed.
            view.AskRemoveKey(TerminalKeyKind.Sudo);
            Await(view.RemoveKeyAsync(TerminalKeyKind.Sudo));
            // An older BellTeam answers 404 without TERMINAL_NOT_FOUND: the row becomes the one line, and the request is not sent again.
            wire.Answer = (method, _) => method == "GET" ? StubHandler.Json(List(Mini)) : Error(HttpStatusCode.NotFound, "NOT_FOUND");
            var before = wire.Calls.Count; Await(view.SetKeyAsync(TerminalKeyKind.Ssh));
            Assert.Equal(before + 1, wire.Calls.Count); Assert.Single(opened);
            Assert.Contains(LogicalTree.Find<System.Windows.Controls.TextBlock>(view).Select(text => text.Text), text => text == "このBellTeamはまだアプリからの鍵の設定に対応していません");
        });
        Assert.Null(opened[0].BotId); Assert.Equal("terminal.ssh", opened[0].Purpose);
        // The list is read after the request (it says pending) and again once the card closed; a removal reads it once; the refused request is not sent twice.
        Assert.Equal(["GET /api/terminals", "POST /api/terminals/mini/keys/ssh", "GET /api/terminals", "GET /api/terminals", "DELETE /api/terminals/mini/keys/sudo", "GET /api/terminals", "POST /api/terminals/mini/keys/ssh"], wire.Calls);
    }

    // ---- 「この鍵を入れる」 ----
    private static string Probe(bool pending, string? outcome, string requestId = "r1", string os = "macos")
        => Mini[..^1] + ",\"os\":\"" + os + "\",\"keyAuthorizationPending\":" + (pending ? "true" : "false") + (outcome is null ? "" : ",\"keyAuthorization\":{\"requestId\":\"" + requestId + "\",\"outcome\":\"" + outcome + "\"}") + "}";
    private const string LoginCard = """{"secretRequest":{"id":"r1","label":"端末 mini のMacのログインパスワード","purpose":"terminal.login","botId":null}}""";

    [Fact]
    public async Task TheAuthorizeFlowReadsUntilItsOutcomeThenChecksOnce()
    {
        var reads = 0; var wire = new Wire();
        wire.Answer = (method, path) => (method, path) switch
        {
            ("GET", "/api/terminals") => StubHandler.Json(List(Mini)),
            ("POST", "/api/terminals/mini/keys/ssh/authorize") => StubHandler.Json(LoginCard),
            // Pending, then a stale outcome of an older request, then this request's outcome.
            ("GET", "/api/terminals/mini") => StubHandler.Json(++reads == 1 ? Probe(true, null) : reads == 2 ? Probe(false, "PASSWORD_REJECTED", "older") : Probe(false, "AUTHORIZED")),
            ("POST", "/api/terminals/mini/check") => StubHandler.Json("""{"terminalId":"mini","reachable":true,"observedAt":"2026-11-11T08:00:00Z"}"""),
            _ => StubHandler.Json("{}")
        };
        using var api = wire.Api(); var model = new TerminalsModel(new TerminalsApi(api)); await model.RefreshAsync();
        model.Checks["mini"] = Check("AUTH_FAILED", reachable: false);
        var request = await model.RequestKeyAuthorizationAsync("mini");
        Assert.Equal("r1", request!.Id); Assert.Null(request.BotId); Assert.Equal("terminal.login", request.Purpose); Assert.Equal("{}", wire.Bodies[^1]);
        await model.AwaitKeyAuthorizationAsync("mini", "r1", TimeSpan.FromMilliseconds(1));
        Assert.Equal(3, reads); Assert.False(model.Authorizations.ContainsKey("mini"));
        // The key is on the terminal: the old observation is gone and exactly one check ran by itself.
        Assert.Single(wire.Calls, call => call == "POST /api/terminals/mini/check"); Assert.True(model.Checks["mini"].Reachable); Assert.Empty(model.Checking);
        Assert.Equal(1, wire.Calls.Count(call => call.StartsWith("POST /api/terminals/mini/keys/ssh/authorize", StringComparison.Ordinal)));
    }

    [Fact]
    public async Task AFailedReadKeepsWaitingAndAFailedAutomaticCheckSaysTheKeyIsOnTheTerminal()
    {
        var reads = 0; var wire = new Wire();
        wire.Answer = (method, path) => (method, path) switch
        {
            ("GET", "/api/terminals") => StubHandler.Json(List(Probe(false, null, os: "windows"))),
            ("GET", "/api/terminals/mini") => ++reads == 1 ? Error(HttpStatusCode.BadGateway, "BAD") : StubHandler.Json(Probe(false, "ALREADY_AUTHORIZED", os: "windows")),
            ("POST", "/api/terminals/mini/check") => Error(HttpStatusCode.ServiceUnavailable, "TERMINAL_UNAVAILABLE"),
            _ => StubHandler.Json("{}")
        };
        using var api = wire.Api(); var model = new TerminalsModel(new TerminalsApi(api)); await model.RefreshAsync();
        var seen = new List<AuthorizeState?>(); model.Changed += () => seen.Add(model.Authorizations.GetValueOrDefault("mini"));
        await model.AwaitKeyAuthorizationAsync("mini", "r1", TimeSpan.FromMilliseconds(1));
        Assert.Contains(new AuthorizeState.Waiting("r1", true), seen);
        Assert.Equal(new AuthorizeState.Shown(new("鍵はWindows PCに入りました。つながるかは確かめられませんでした。「つながるか確かめる」を押してください。")), model.Authorizations["mini"]);
        Assert.Single(wire.Calls, call => call == "POST /api/terminals/mini/check");
    }

    [Fact]
    public async Task ALaterRequestOrALeftPageEndsTheWaitWithoutACheck()
    {
        var wire = new Wire { Answer = (method, path) => method == "GET" && path == "/api/terminals" ? StubHandler.Json(List(Mini)) : StubHandler.Json(Probe(true, null)) }; using var api = wire.Api();
        var model = new TerminalsModel(new TerminalsApi(api)); await model.RefreshAsync();
        using var left = new CancellationTokenSource(); var wait = model.AwaitKeyAuthorizationAsync("mini", "r1", TimeSpan.FromMilliseconds(1), left.Token);
        model.Authorizations["mini"] = new AuthorizeState.Waiting("r2", false); await wait;
        Assert.Equal(new AuthorizeState.Waiting("r2", false), model.Authorizations["mini"]);
        using var gone = new CancellationTokenSource(); gone.Cancel(); await model.AwaitKeyAuthorizationAsync("mini", "r1", TimeSpan.FromMilliseconds(1), gone.Token);
        Assert.DoesNotContain("POST /api/terminals/mini/check", wire.Calls);
    }

    [Theory]
    [InlineData("PASSWORD_REJECTED", "パスワードが違いました。", true)]
    [InlineData("AUTHORIZATION_UNCONFIRMED", "入れられたか確かめられませんでした。もう一度お試しください", true)]
    [InlineData("TERMINAL_CHANGED", "入れている間に、端末の接続先が変わりました。もう一度お試しください。", true)]
    [InlineData("TERMINAL_UNAVAILABLE", "Windows PCにつながりませんでした。Windows PCが起きていて同じネットワークにあるか確かめて、もう一度お試しください。", true)]
    [InlineData("PASSWORD_AUTH_DISABLED", "このWindows PCはパスワードでのログインを受け付けていません。Windows PCの設定を変えるか、鍵をほかの方法で入れてください。", false)]
    [InlineData("CREDENTIAL_UNAVAILABLE", "SSH鍵が使えませんでした。下の「鍵」で設定し直してから、もう一度お試しください。", false)]
    [InlineData("SOMETHING", "Windows PCに鍵を入れられませんでした。もう一度お試しください。", true)]
    public void EachAuthorizeOutcomeHasItsWordsAndOnlyTheRetriableOnesOfferTheButtonAgain(string outcome, string text, bool retry)
    {
        Assert.Equal(new AuthorizeNote(text, retry), TerminalAuthorize.Note(outcome, "windows"));
        Assert.Equal(retry, new AuthorizeState.Shown(TerminalAuthorize.Note(outcome)!).Retry);
    }

    [Fact]
    public void AuthorizedMeansNoSentenceAndTheRefusalsThatNeedNoPasswordHaveWords()
    {
        Assert.Null(TerminalAuthorize.Note("AUTHORIZED")); Assert.Null(TerminalAuthorize.Note("ALREADY_AUTHORIZED"));
        BellApiException Fail(HttpStatusCode status, string code) => new("BellTeam: x", status, code);
        Assert.Equal(new AuthorizeNote("先にこのLinuxマシンを確かめてください。ホスト鍵を確かめる前は、パスワードを聞きません。"), TerminalAuthorize.Refusal(Fail(HttpStatusCode.Conflict, "HOST_TRUST_MISSING"), "linux"));
        Assert.Equal(new AuthorizeNote("先にSSH鍵を設定してください。入れる鍵がまだありません。"), TerminalAuthorize.Refusal(Fail(HttpStatusCode.Conflict, "SSH_KEY_UNSET")));
        Assert.Equal(new AuthorizeNote("いまはパスワードの入力欄を開けません。少し待ってから、もう一度お試しください。", true), TerminalAuthorize.Refusal(Fail(HttpStatusCode.ServiceUnavailable, "CREDENTIAL_UNAVAILABLE")));
        Assert.Equal(new AuthorizeNote("このBellTeamはまだ、アプリからMacに鍵を入れることに対応していません。"), TerminalAuthorize.Refusal(Fail(HttpStatusCode.NotFound, "NOT_FOUND")));
        Assert.Null(TerminalAuthorize.Refusal(Fail(HttpStatusCode.NotFound, "TERMINAL_NOT_FOUND"))); Assert.Null(TerminalAuthorize.Refusal(new HttpRequestException("down")));
        Assert.Equal("Windows PCに鍵を入れています…", TerminalAuthorize.WaitingText("windows")); Assert.Equal("状態を読み込めませんでした。つながり直したら続けます…", TerminalAuthorize.ReadFailedText);
    }

    [Fact]
    public async Task ARefusedAuthorizeShowsItsSentenceAndOpensNoCard()
    {
        var wire = new Wire { Answer = (method, path) => method == "GET" ? StubHandler.Json(List(Mini)) : Error(HttpStatusCode.Conflict, "HOST_TRUST_MISSING") }; using var api = wire.Api();
        var model = new TerminalsModel(new TerminalsApi(api)); await model.RefreshAsync();
        Assert.Null(await model.RequestKeyAuthorizationAsync("mini"));
        var note = Assert.IsType<AuthorizeState.Shown>(model.Authorizations["mini"]).Note; Assert.Equal("先にこのMacを確かめてください。ホスト鍵を確かめる前は、パスワードを聞きません。", note.Text); Assert.False(note.Retry);
        // Anything without its own wording is thrown for the screen to show; it is not resent.
        wire.Answer = (_, _) => Error(HttpStatusCode.InternalServerError, "BOOM");
        await Assert.ThrowsAsync<BellApiException>(() => model.RequestKeyAuthorizationAsync("mini"));
        Assert.Equal(2, wire.Calls.Count(call => call.StartsWith("POST", StringComparison.Ordinal)));
    }

    [Fact]
    public async Task TwoPressesShareOneCheckAndAnAdoptedHostKeyIsReadBack()
    {
        var wire = new Wire(); using var api = wire.Api();
        var checks = 0;
        wire.Answer = (method, path) => (method, path) switch
        {
            ("GET", "/api/terminals") => StubHandler.Json(List(Mini.Replace(",\"hostTrust\":{\"trustRevision\":1}", ""))),
            ("POST", "/api/terminals/mini/check") => StubHandler.Json($$"""{"terminalId":"mini","reachable":true,"observedAt":"2026-11-11T0{{++checks}}:00:00Z"}"""),
            _ => StubHandler.Json("{}")
        };
        var model = new TerminalsModel(new TerminalsApi(api)); await model.RefreshAsync();
        Assert.False(model.Find("mini")!.HostTrusted);
        // Two presses at once share the check in flight; the server adopted the first host key, so the list is read again.
        var release = new TaskCompletionSource(); wire.HoldChecks = release.Task;
        var first = model.CheckAsync("mini"); var second = model.CheckAsync("mini"); Assert.Contains("mini", model.Checking); release.SetResult(); await Task.WhenAll(first, second);
        Assert.Equal(1, checks); Assert.Equal(["GET /api/terminals", "POST /api/terminals/mini/check", "GET /api/terminals"], wire.Calls); Assert.Empty(model.Checking);
    }

    // A WPF element belongs to the thread that made it, so the thread has a dispatcher and every await comes back to it.
    private static void RunSta(Action action)
    {
        Exception? failure = null;
        var thread = new Thread(() => { try { SynchronizationContext.SetSynchronizationContext(new DispatcherSynchronizationContext(Dispatcher.CurrentDispatcher)); action(); } catch (Exception error) { failure = error; } finally { Dispatcher.CurrentDispatcher.InvokeShutdown(); } });
        thread.SetApartmentState(ApartmentState.STA); thread.Start(); thread.Join();
        if (failure is not null) System.Runtime.ExceptionServices.ExceptionDispatchInfo.Capture(failure).Throw();
    }
    private static void Await(Task task)
    {
        var deadline = DateTime.UtcNow.AddSeconds(10);
        while (!task.IsCompleted) { if (DateTime.UtcNow > deadline) throw new TimeoutException(); var frame = new DispatcherFrame(); Dispatcher.CurrentDispatcher.BeginInvoke(DispatcherPriority.Background, new Action(() => frame.Continue = false)); Dispatcher.PushFrame(frame); Thread.Sleep(1); }
        task.GetAwaiter().GetResult();
    }
}
