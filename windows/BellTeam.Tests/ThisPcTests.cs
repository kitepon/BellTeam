using System.IO;
using System.Net;
using System.Net.Http;
using System.Text.Json;
using System.Windows.Controls;
using System.Windows.Threading;
using BellTeam.App;
using BellTeam.Core;

namespace BellTeam.Tests;

// W-MAC 16c: 「このPCを追加」 (S1) and the PC attesting its own host key (S2). Every read of the PC goes through a fake; nothing touches the real network or file system.
public sealed class ThisPcTests
{
    // A fixed ed25519 host key blob (type string, then the 32 bytes 1..32). The fingerprint is what `ssh-keygen -lf` prints for it.
    private const string Blob = "AAAAC3NzaC1lZDI1NTE5AAAAIAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8g";
    private const string Fingerprint = "SHA256:mKqU+0K8OhKmA8bBQi9Rz0Q5l7/g160hIP+rJYSTNj4";
    private static string Pub(string comment = "system@fox") => $"ssh-ed25519 {Blob} {comment}\r\n";

    private sealed class FakePc : IThisPc
    {
        public List<PcInterface> Adapters { get; set; } = [new("Loopback Pseudo-Interface 1", "127.0.0.1", false, false), new("Ethernet", "192.168.1.11", false, true), new("Ethernet", "fe80::1c2d:3e4f:5a6b:7c8d%12", true, true), new("Ethernet", "fd00::11", true, true)];
        public string MachineName { get; set; } = "FOX";
        public string UserName { get; set; } = "kite_";
        public string UserDomain { get; set; } = "FOX";
        public OpenSshState OpenSsh { get; set; } = OpenSshState.On;
        public Func<string> HostKey { get; set; } = () => Pub();
        public int KeyReads, ProbeCount, InterfaceReads;
        public IReadOnlyList<PcInterface> Interfaces() { InterfaceReads++; return Adapters; }
        public Task<OpenSshState> OpenSshAsync(int port, CancellationToken token) { ProbeCount++; Assert.Equal(22, port); return Task.FromResult(OpenSsh); }
        public Task<string> ReadHostKeyAsync(CancellationToken token) { KeyReads++; return Task.FromResult(HostKey()); }
    }

    // ---- the host key file -> fingerprint ----
    [Fact]
    public void TheFingerprintIsTheSha256OfTheDecodedKeyBlobAndFollowsTheServersRule()
    {
        Assert.Equal(Fingerprint, HostKeyFile.Fingerprint(Pub()));
        Assert.Null(HostKeyFingerprint.Problem(Fingerprint)); Assert.Equal(7 + 43, Fingerprint.Length);
        // A blank line first, a comment with spaces, no comment at all, and CR LF are all the same key.
        Assert.Equal(Fingerprint, HostKeyFile.Fingerprint("\r\n  " + Pub("a comment with spaces") + "\r\nssh-ed25519 other"));
        Assert.Equal(Fingerprint, HostKeyFile.Fingerprint($"ssh-ed25519 {Blob}"));
    }

    [Fact]
    public void AFileThatIsNotAnEd25519KeyOrIsBrokenIsNamedAndNeverGuessed()
    {
        var rsa = Assert.Throws<HostKeyFileException>(() => HostKeyFile.Fingerprint("ssh-rsa AAAAB3NzaC1yc2E system@fox"));
        Assert.Equal((HostKeyFileProblem.NotEd25519, "ssh-rsa"), (rsa.Problem, rsa.KeyType));
        foreach (var broken in new[] { "", "   \r\n", "ssh-ed25519", "ssh-ed25519 !!!notbase64", "ssh-ed25519 " + Blob[..^4], "ssh-ed25519 " + Blob + "AAAA", "ssh-ed25519 AAAAB3NzaC1yc2EAAAADAQABAAAAgQ" })
            Assert.Equal(HostKeyFileProblem.Malformed, Assert.Throws<HostKeyFileException>(() => HostKeyFile.Fingerprint(broken)).Problem);
        // The right length but another key type inside is not an ed25519 key either.
        byte[] raw = [0, 0, 0, 11, .. "ssh-ed25518"u8, 0, 0, 0, 32, .. new byte[32]];
        Assert.Equal(HostKeyFileProblem.Malformed, Assert.Throws<HostKeyFileException>(() => HostKeyFile.Fingerprint("ssh-ed25519 " + Convert.ToBase64String(raw))).Problem);
    }

    [Fact]
    public void EveryLocalFailureHasAReasonAndPointsToTheManualFingerprint()
    {
        var missing = ThisPcTrust.Local(new FileNotFoundException());
        Assert.Contains(@"C:\ProgramData\ssh\ssh_host_ed25519_key.pub", missing.Text); Assert.Contains("OpenSSH SSH Server", missing.Text);
        Assert.True(missing.OffersOptionalFeatures); Assert.True(ThisPcTrust.Local(new DirectoryNotFoundException()).OffersOptionalFeatures);
        var notes = new[] { ThisPcTrust.Local(new UnauthorizedAccessException()), ThisPcTrust.Local(new IOException("in use")), ThisPcTrust.Local(new HostKeyFileException(HostKeyFileProblem.NotEd25519, "ssh-rsa")), ThisPcTrust.Local(new HostKeyFileException(HostKeyFileProblem.Malformed)), ThisPcTrust.Local(new InvalidOperationException()), missing };
        Assert.All(notes, note => { Assert.Contains("「ほかの方法」で指紋を入れて確かめられます。", note.Text); Assert.True(note.OffersOtherWays); });
        Assert.All(notes.Take(5), note => Assert.False(note.OffersOptionalFeatures));
        Assert.Contains("ed25519の鍵ではありません（ssh-rsa）", notes[2].Text); Assert.Contains("読む権限がありません", notes[0].Text);
        // The OS's English message is never shown.
        Assert.DoesNotContain("in use", notes[1].Text);
    }

    // ---- this PC's addresses ----
    [Fact]
    public void AHostIsThisPcWhenItIsAnAddressOfThisPcOrItsNameInAnyCase()
    {
        var pc = new FakePc();
        foreach (var own in new[] { "192.168.1.11", " 192.168.1.11 ", "127.0.0.1", "::1", "localhost", "LocalHost", "fd00::11", "FD00:0:0:0:0:0:0:11", "fe80::1c2d:3e4f:5a6b:7c8d", "fe80::1c2d:3e4f:5a6b:7c8d%12", "fox", "FOX", "Fox", "fox.local", "FOX.LOCAL" })
            Assert.True(ThisPcFacts.Owns(own, pc), own);
        foreach (var other in new[] { "", "  ", "192.168.1.12", "192.168.1.1", "10.0.0.11", "::2", "fd00::12", "fox2", "foxy.local", "office-imac.local", "fox.example.com", "999.1.1.1", "192.168.1", "192.168.1.11.5", "1:2:3", "not:an:address" })
            Assert.False(ThisPcFacts.Owns(other, pc), other);
        // A machine name in the host box is the PC's own, the other way round too: the name with .local is matched against the bare name.
        pc.MachineName = "Fox-Desk"; Assert.True(ThisPcFacts.Owns("fox-desk.local", pc)); Assert.True(ThisPcFacts.Owns("FOX-DESK", pc)); Assert.False(ThisPcFacts.Owns("fox", pc));
        pc.MachineName = ""; Assert.False(ThisPcFacts.Owns("anything", pc));
        // The adapters are only read for an IP address; a name never lists them.
        pc.InterfaceReads = 0; ThisPcFacts.Owns("fox-desk", pc); ThisPcFacts.Owns("localhost", pc); Assert.Equal(0, pc.InterfaceReads);
    }

    [Fact]
    public void ThePrimaryAddressIsTheFirstLanIpv4OfTheAdapterThatHasAGatewayAndNeverLoopbackOrLinkLocal()
    {
        PcInterface V4(string address, bool gateway, string name = "Ethernet") => new(name, address, false, gateway);
        Assert.Equal("192.168.1.11", ThisPcFacts.PrimaryIPv4(new FakePc().Adapters));
        // A Hyper-V or WSL adapter listed first has no gateway; the one with a gateway wins.
        Assert.Equal("192.168.1.11", ThisPcFacts.PrimaryIPv4([V4("172.24.0.1", false, "vEthernet (WSL)"), V4("169.254.5.5", true), V4("127.0.0.1", true), V4("192.168.1.11", true), V4("10.0.0.5", true, "Wi-Fi")]));
        // Without any gateway the first usable one is taken (an isolated LAN).
        Assert.Equal("10.0.0.5", ThisPcFacts.PrimaryIPv4([V4("169.254.5.5", false), V4("10.0.0.5", false), V4("10.0.0.6", false)]));
        // IPv6 is never the host of the form; nothing usable is null.
        Assert.Null(ThisPcFacts.PrimaryIPv4([new("Ethernet", "fd00::11", true, true), V4("127.0.0.1", false), V4("169.254.1.1", false)])); Assert.Null(ThisPcFacts.PrimaryIPv4([]));
    }

    [Fact]
    public void TheUserIsTheLocalAccountNameAndAnEmptyFieldForADomainAccount()
    {
        Assert.Equal("kite_", ThisPcFacts.SshUser(new FakePc()));
        Assert.Equal("kite_", ThisPcFacts.SshUser(new FakePc { UserDomain = "fox" }));
        // DOMAIN\user is never prefilled, and neither is an Entra ID (AzureAD) account.
        Assert.Equal("", ThisPcFacts.SshUser(new FakePc { UserDomain = "CORP" })); Assert.Equal("", ThisPcFacts.SshUser(new FakePc { UserDomain = "AzureAD" }));
    }

    // ---- HTTP: a stub registry that records what was sent ----
    private sealed class Wire
    {
        public readonly List<string> Calls = [], Bodies = [];
        public Func<string, string, HttpResponseMessage> Answer = (_, _) => StubHandler.Json("{}");
        private Task<HttpResponseMessage> Record(HttpRequestMessage request)
        {
            Calls.Add($"{request.Method} {request.RequestUri!.AbsolutePath}"); Bodies.Add(request.Content is null ? "" : request.Content.ReadAsStringAsync().GetAwaiter().GetResult());
            return Task.FromResult(Answer(request.Method.Method, request.RequestUri.AbsolutePath));
        }
        public BellApi Api() => new(new("http://localhost/"), new StubHandler((request, _) => Record(request)));
        public Workspace Workspace(IThisPc pc) => new(origin => new BellApi(origin, new StubHandler((request, _) => request.RequestUri!.AbsolutePath.StartsWith("/api/terminals", StringComparison.Ordinal) ? Record(request)
            : Task.FromResult(StubHandler.Json(request.RequestUri.AbsolutePath switch { "/api/session" => """{"authenticated":true,"authMode":"local"}""", "/api/bots" => ApiTests.Bots, "/api/rooms" => ApiTests.Rooms, "/api/queue" => ApiTests.EmptyQueue, "/api/owner" => ApiTests.Owner, _ => ApiTests.Page }))))) { ThisPc = pc };
        public int Trusts => Calls.Count(call => call.EndsWith("/trust", StringComparison.Ordinal));
    }
    private static HttpResponseMessage Error(HttpStatusCode status, string code, string? message = null) => StubHandler.Json(JsonSerializer.Serialize(new { error = code, message }), status);
    private static string Fox(bool trusted = false, string host = "192.168.1.11", string id = "fox") => $$"""{"terminalId":"{{id}}","host":"{{host}}","user":"kite_","port":22,"os":"windows","accountOwner":"owner","sshKeyConfigured":false,"sudoKeyConfigured":false,"sshKeyPending":false,"sudoKeyPending":false{{(trusted ? ",\"hostTrust\":{\"trustRevision\":1}" : "")}}}""";
    private static string List(params string[] terminals) => "{\"terminals\":[" + string.Join(",", terminals) + "]}";
    // A write answers with the terminal of its path: PUT as saved (untrusted), POST …/trust as trusted. Ids "far" and "elsewhere" are other PCs, "by-name" is this PC by its name.
    private static HttpResponseMessage Written(string path, bool trusted)
    {
        var id = path.Split('/')[3];
        var terminal = Fox(trusted, id is "far" or "elsewhere" ? "192.168.1.99" : id == "by-name" ? "fox" : "192.168.1.11", id);
        return StubHandler.Json(trusted ? "{\"terminal\":" + terminal + "}" : terminal);
    }
    private static Wire Registry(params string[] terminals) => new() { Answer = (method, path) => method == "GET" ? StubHandler.Json(List(terminals)) : path.EndsWith("/trust", StringComparison.Ordinal) ? Written(path, true) : method == "PUT" ? Written(path, false) : StubHandler.Json("{}") };

    // ---- the trust request ----
    // The body is exactly one field; the JSON writer may escape "+" as +, so it is read back rather than compared as text.
    private static void AssertTrustBody(string body)
    {
        using var json = JsonDocument.Parse(body);
        Assert.Equal([("fingerprint", Fingerprint)], json.RootElement.EnumerateObject().Select(field => (field.Name, field.Value.GetString()!)));
    }

    [Fact]
    public async Task TheTrustRequestCarriesTheFingerprintAndNothingElseAndTheListFollowsTheAnswer()
    {
        var wire = Registry(Fox()); using var api = wire.Api(); var pc = new FakePc();
        var model = new TerminalsModel(new TerminalsApi(api), pc);
        await model.RefreshAsync(); await model.AttestationsDone;
        Assert.Equal(["GET /api/terminals", "POST /api/terminals/fox/trust"], wire.Calls);
        AssertTrustBody(wire.Bodies[1]);
        Assert.True(model.Find("fox")!.HostTrusted); Assert.Empty(model.TrustNotes); Assert.Empty(model.Attesting); Assert.Equal(1, pc.KeyReads);
    }

    [Fact]
    public async Task TheListReadAttestsAnUntrustedTerminalOfThisPcOnceAndNeverATrustedOrForeignOne()
    {
        var wire = Registry(Fox(), Fox(true, id: "trusted"), Fox(host: "192.168.1.99", id: "elsewhere"), Fox(host: "fox", id: "by-name"));
        using var api = wire.Api(); var model = new TerminalsModel(new TerminalsApi(api), new FakePc());
        await model.RefreshAsync(); await model.AttestationsDone;
        Assert.Equal(["POST /api/terminals/fox/trust", "POST /api/terminals/by-name/trust"], wire.Calls.Where(call => call.StartsWith("POST", StringComparison.Ordinal)));
        // A later read (the server still says untrusted) does not try again: one attempt per trigger, once per connection.
        wire.Calls.Clear(); await model.RefreshAsync(); await model.AttestationsDone; Assert.Equal(["GET /api/terminals"], wire.Calls);
        // Without a PC (an old test model) nothing is attested.
        var plain = new TerminalsModel(new TerminalsApi(api)); wire.Calls.Clear(); await plain.RefreshAsync(); await plain.AttestationsDone; Assert.Equal(["GET /api/terminals"], wire.Calls);
    }

    [Fact]
    public async Task TheButtonAttestsOncePerPressAndTwoPressesAtOnceShareOne()
    {
        var read = new TaskCompletionSource<string>(); var pc = new HeldPc(read.Task);
        var wire = Registry(Fox(true)); using var api = wire.Api();
        var model = new TerminalsModel(new TerminalsApi(api), pc); await model.RefreshAsync(); await model.AttestationsDone;
        Assert.Equal(0, wire.Trusts); // the list read does not attest a trusted terminal
        var first = model.AttestAsync("fox"); var second = model.AttestAsync("fox"); Assert.Contains("fox", model.Attesting);
        read.SetResult(Pub()); await Task.WhenAll(first, second);
        Assert.Equal((1, 1), (wire.Trusts, pc.Reads)); Assert.Empty(model.Attesting);
        await model.AttestAsync("fox"); Assert.Equal(2, wire.Trusts);
    }
    private sealed class HeldPc(Task<string> text) : IThisPc
    {
        public int Reads;
        public IReadOnlyList<PcInterface> Interfaces() => [new("Ethernet", "192.168.1.11", false, true)];
        public string MachineName => "FOX"; public string UserName => "kite_"; public string UserDomain => "FOX";
        public Task<OpenSshState> OpenSshAsync(int port, CancellationToken token) => Task.FromResult(OpenSshState.On);
        public Task<string> ReadHostKeyAsync(CancellationToken token) { Reads++; return text; }
    }

    [Fact]
    public async Task ASavedNewTerminalOfThisPcIsAttestedOnceAndAnotherPcIsNot()
    {
        var wire = Registry();
        using var api = wire.Api(); var model = new TerminalsModel(new TerminalsApi(api), new FakePc());
        await model.RefreshAsync();
        var saved = await model.SaveAsync("elsewhere", new TerminalDraft { TerminalId = "elsewhere", Host = "192.168.1.99", User = "kite_", Os = TerminalOS.Windows });
        await model.AttestOnce(saved); Assert.Equal(0, wire.Trusts);
        saved = await model.SaveAsync("fox", new TerminalDraft { TerminalId = "fox", Host = "192.168.1.11", User = "kite_", Os = TerminalOS.Windows });
        await model.AttestOnce(saved); await model.AttestOnce(saved); Assert.Equal(1, wire.Trusts);
        // A removed terminal that is added again is attested again.
        await model.RemoveAsync("fox"); Assert.Empty(model.Attested);
        await model.AttestOnce(saved); Assert.Equal(2, wire.Trusts);
    }

    // ---- every outcome is a line, and nothing is sent twice ----
    [Theory]
    [InlineData(409, "HOST_KEY_FINGERPRINT_MISMATCH", "このアドレスで答えているのは、このPCではありません。ホストの入力を確かめてください。信用は何も書いていません。")]
    [InlineData(409, "TERMINAL_CHANGED", "確かめている間に、端末の接続先が変わりました。もう一度「このPCを確かめる」を押してください。")]
    [InlineData(503, "TERMINAL_UNAVAILABLE", "いまはBellTeamからこのPCを確かめられません。PCが起きていて同じネットワークにあるか確かめて、あとでもう一度押してください。")]
    [InlineData(404, "TERMINAL_NOT_FOUND", "この端末の登録が見つかりません。一覧を読み直してください。")]
    [InlineData(400, "INVALID_TERMINAL", "入力の形が違います。各欄を確かめてください。")]
    public async Task EachServerAnswerBecomesOneLineAndIsNotResent(int status, string code, string text)
    {
        var wire = new Wire { Answer = (method, _) => method == "GET" ? StubHandler.Json(List(Fox())) : Error((HttpStatusCode)status, code, "english") };
        using var api = wire.Api(); var model = new TerminalsModel(new TerminalsApi(api), new FakePc());
        await model.RefreshAsync(); await model.AttestationsDone;
        Assert.Equal(text, model.TrustNotes["fox"].Text); Assert.False(model.TrustNotes["fox"].OffersOptionalFeatures); Assert.False(model.Find("fox")!.HostTrusted);
        Assert.Equal(1, wire.Trusts); Assert.Empty(model.Attesting);
        // The next press clears the line first and sends exactly one more.
        await model.AttestAsync("fox"); Assert.Equal(2, wire.Trusts);
    }

    [Fact]
    public async Task AnOlderBodyAndASignedOutSessionSayNothingAndTheKeyFileProblemsSendNothing()
    {
        var wire = new Wire { Answer = (method, _) => method == "GET" ? StubHandler.Json(List(Fox())) : Error(HttpStatusCode.NotFound, "NOT_FOUND") };
        using var api = wire.Api(); var model = new TerminalsModel(new TerminalsApi(api), new FakePc());
        await model.RefreshAsync(); await model.AttestationsDone;
        Assert.Empty(model.TrustNotes); Assert.Equal(1, wire.Trusts);
        wire.Answer = (_, _) => Error(HttpStatusCode.Unauthorized, "UNAUTHORIZED"); await model.AttestAsync("fox"); Assert.Empty(model.TrustNotes);
        wire.Answer = (_, _) => new HttpResponseMessage(HttpStatusCode.BadGateway); await model.AttestAsync("fox"); Assert.StartsWith("操作の結果を確認できませんでした。", model.TrustNotes["fox"].Text);
        // The file is missing: the reason is the line, and no request goes to the server.
        var gone = new FakePc { HostKey = () => throw new FileNotFoundException() }; var local = new TerminalsModel(new TerminalsApi(api), gone);
        wire.Calls.Clear(); wire.Answer = (_, _) => StubHandler.Json(List(Fox())); await local.RefreshAsync(); await local.AttestationsDone;
        Assert.True(local.TrustNotes["fox"].OffersOptionalFeatures); Assert.Equal(["GET /api/terminals"], wire.Calls);
        gone.HostKey = () => "ssh-rsa AAAA x"; await local.AttestAsync("fox"); Assert.Contains("ed25519の鍵ではありません", local.TrustNotes["fox"].Text); Assert.Equal(["GET /api/terminals"], wire.Calls);
    }

    // ---- the screens ----
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
    private static string[] Texts(object view) => LogicalTree.Find<TextBlock>(view).Select(text => text.Text).ToArray();

    [Theory]
    [InlineData(OpenSshState.On, false, false)]
    [InlineData(OpenSshState.Off, true, true)]
    [InlineData(OpenSshState.Unknown, true, false)]
    public void ThePcAddFillsTheFormAndAnswersTheLoopbackProbe(OpenSshState state, bool line, bool offersOptionalFeatures)
    {
        var pc = new FakePc { OpenSsh = state }; var wire = Registry();
        RunSta(() =>
        {
            using var workspace = wire.Workspace(pc);
            Await(workspace.ConnectAsync("http://localhost/", listen: false)); Await(workspace.Terminals.RefreshAsync());
            var editor = new TerminalEditorView(workspace, workspace.Terminals, null);
            // Typed values are replaced by this PC's: OS Windows, the LAN address, the account name, port 22, your own terminal.
            editor.Box(TerminalField.Host).Text = "old"; editor.Box(TerminalField.Port).Text = "2222";
            Await(editor.AddThisPcAsync());
            Assert.Equal(("192.168.1.11", "kite_", "22", "windows"), (editor.Box(TerminalField.Host).Text, editor.Box(TerminalField.User).Text, editor.Box(TerminalField.Port).Text, (string)editor.OsPicker.SelectedValue));
            Assert.Equal(1, pc.ProbeCount);
            var texts = Texts(editor);
            Assert.Equal(state == OpenSshState.Off, texts.Contains(ThisPcFacts.OpenSshOffText)); Assert.Equal(state == OpenSshState.Unknown, texts.Contains(ThisPcFacts.OpenSshUnknownText));
            Assert.Equal(state == OpenSshState.Off, texts.Contains(ThisPcFacts.OpenSshOffStep));
            Assert.Equal(offersOptionalFeatures, texts.Contains("オプション機能を開く")); Assert.Equal(line, texts.Any(text => text.StartsWith("OpenSSH サーバー", StringComparison.Ordinal)));
        });
    }

    [Fact]
    public void ADomainAccountLeavesTheUserEmptyAndSaysSoAndAMissingAddressSaysSo()
    {
        var wire = Registry(); var pc = new FakePc { UserDomain = "CORP", Adapters = [new("Loopback", "127.0.0.1", false, false)] };
        RunSta(() =>
        {
            using var workspace = wire.Workspace(pc);
            Await(workspace.ConnectAsync("http://localhost/", listen: false)); Await(workspace.Terminals.RefreshAsync());
            var editor = new TerminalEditorView(workspace, workspace.Terminals, null);
            editor.Box(TerminalField.Host).Text = "typed-host"; editor.Box(TerminalField.User).Text = "old";
            Await(editor.AddThisPcAsync());
            // The host keeps what was typed when no address could be read; the user is empty, never DOMAIN\user.
            Assert.Equal(("typed-host", ""), (editor.Box(TerminalField.Host).Text, editor.Box(TerminalField.User).Text));
            Assert.Contains(ThisPcFacts.AddressMissingText, Texts(editor)); Assert.Contains(ThisPcFacts.DomainUserText, Texts(editor));
        });
    }

    [Fact]
    public void SavingAPcAddedTerminalSendsOnePutThenOneTrustAndNothingForAnotherAddress()
    {
        var wire = Registry();
        RunSta(() =>
        {
            using var workspace = wire.Workspace(new FakePc());
            Await(workspace.ConnectAsync("http://localhost/", listen: false)); Await(workspace.Terminals.RefreshAsync());
            var editor = new TerminalEditorView(workspace, workspace.Terminals, null); Await(editor.AddThisPcAsync());
            editor.Box(TerminalField.TerminalId).Text = "fox"; Await(editor.SaveAsync());
            Await(workspace.Terminals.AttestationsDone);
            Assert.Equal(["GET /api/terminals", "PUT /api/terminals/fox", "POST /api/terminals/fox/trust"], wire.Calls);
            AssertTrustBody(wire.Bodies[^1]); Assert.True(workspace.Terminals.Find("fox")!.HostTrusted);
            // A terminal that is not this PC is saved and nothing is attested.
            wire.Calls.Clear(); var other = new TerminalEditorView(workspace, workspace.Terminals, null);
            other.Box(TerminalField.TerminalId).Text = "far"; other.Box(TerminalField.Host).Text = "192.168.1.99"; other.Box(TerminalField.User).Text = "kite"; Await(other.SaveAsync()); Await(workspace.Terminals.AttestationsDone);
            Assert.Equal(["PUT /api/terminals/far"], wire.Calls);
        });
    }

    [Fact]
    public void TheDetailOffersTheButtonOnlyForThisPcAndShowsTheServersActionAndTheOptionalFeaturesFixForARefusal()
    {
        var wire = Registry(Fox(), Fox(host: "192.168.1.99", id: "far")); var pc = new FakePc();
        RunSta(() =>
        {
            using var workspace = wire.Workspace(pc);
            Await(workspace.ConnectAsync("http://localhost/", listen: false)); workspace.Terminals.Attested.UnionWith(["fox", "far"]); Await(workspace.Terminals.RefreshAsync());
            var own = new TerminalDetailView(workspace, "fox", CancellationToken.None); var far = new TerminalDetailView(workspace, "far", CancellationToken.None);
            Assert.Contains("このPCを確かめる", Texts(own)); Assert.DoesNotContain("このPCを確かめる", Texts(far));
            // The refusal of the reachability check gets the fix button on this PC only.
            workspace.Terminals.Checks["fox"] = new() { TerminalId = "fox", Reachable = false, Reason = "CONNECTION_REFUSED" }; workspace.Terminals.Checks["far"] = new() { TerminalId = "far", Reachable = false, Reason = "CONNECTION_REFUSED" }; workspace.Terminals.Notify();
            Assert.Contains("オプション機能を開く", Texts(own)); Assert.DoesNotContain("オプション機能を開く", Texts(far));
            // The server's action for another PC's untrusted terminal is shown as it is.
            workspace.Terminals.Checks["far"] = new() { TerminalId = "far", Reachable = false, Reason = "HOST_TRUST_MISSING", Action = "192.168.1.99 のWindowsを確かめてください。そのWindowsでBellTeamアプリを開くと、自動で確かめます" }; workspace.Terminals.Notify();
            Assert.Contains("サーバーの案内: 192.168.1.99 のWindowsを確かめてください。そのWindowsでBellTeamアプリを開くと、自動で確かめます", Texts(far));
            // A press sends once and the result line appears; a file problem offers the other ways and the optional features.
            Await(workspace.Terminals.AttestAsync("fox")); Assert.Equal(1, wire.Trusts); Assert.True(workspace.Terminals.Find("fox")!.HostTrusted);
            pc.HostKey = () => throw new FileNotFoundException(); Await(workspace.Terminals.AttestAsync("far")); Assert.Equal(1, wire.Trusts);
            Assert.Contains(Texts(far), text => text.StartsWith("このPCのホスト鍵のファイルがありません", StringComparison.Ordinal)); Assert.Contains(LogicalTree.Find<Expander>(far), expander => (string)expander.Header == "ほかの方法"); Assert.Contains("オプション機能を開く", Texts(far));
        });
    }
}
