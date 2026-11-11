using System.Net;
using System.Net.Http;
using System.Text.Json;
using System.Windows;
using System.Windows.Controls;
using System.Windows.Threading;
using BellTeam.App;
using BellTeam.Core;

namespace BellTeam.Tests;

// W-MAC 16b: the member editor's 端末とフォルダ (binding rules, prefill, folder picker, refusal words, what the save sends).
public sealed class MemberFolderTests
{
    private const string Id = "BOT_TERMINAL_ID_INVALID", Root = "BOT_PROJECT_ROOT_INVALID", Pair = "BOT_REMOTE_BINDING_INVALID";
    private static string? Wrong(string code, string os = "macos") => TerminalErrorText.Member(code, os);

    // ---- MemberBinding ----
    [Theory]
    [InlineData("macos")]
    [InlineData("linux")]
    [InlineData("freebsd")]
    public void PosixTerminalsTakeAnAbsoluteSlashPath(string os)
    {
        Assert.Null(MemberBinding.Problem("", "", os)); Assert.Null(MemberBinding.Problem("owner-mac", "/Users/kite/work", os)); Assert.Null(MemberBinding.Problem("owner-mac", "/", os));
        Assert.Equal("フォルダを入れてください。端末で席が起動する場所です。", MemberBinding.Problem("owner-mac", "", os));
        Assert.Equal(Wrong(Pair), MemberBinding.Problem("", "/Users/kite", os));
        Assert.Equal(Wrong(Id), MemberBinding.Problem("-bad", "/Users/kite", os)); Assert.Equal(Wrong(Id), MemberBinding.Problem(new string('a', 129), "/x", os));
        foreach (var path in new[] { "Users/kite", @"C:\Users\kite", "/a//b", "/a/", "/a/./b", "/a/..", "/a\0b" }) Assert.Equal(Wrong(Root), MemberBinding.Problem("owner-mac", path, os));
        Assert.Equal(Wrong(Root), MemberBinding.Problem("owner-mac", "/" + new string('あ', 1366), os));
        Assert.Null(MemberBinding.Problem("owner-mac", "/" + new string('あ', 1365), os));
    }

    [Fact]
    public void WindowsTerminalsTakeADriveAbsoluteBackslashPath()
    {
        const string os = "windows";
        Assert.Null(MemberBinding.Problem("fox", @"C:\", os)); Assert.Null(MemberBinding.Problem("fox", @"C:\Users\kite_\work", os)); Assert.Null(MemberBinding.Problem("fox", @"d:\x", os));
        Assert.Equal(Wrong(Root, os), MemberBinding.Problem("fox", "/Users/kite", os));
        foreach (var path in new[] { "C:/Users/kite", @"C:\Users\kite\", @"C:\a\\b", @"C:\a\.\b", @"C:\a\..", @"C:Users", @"C:\a/b", "C:\\a\0", @"\\server\share" }) Assert.Equal(Wrong(Root, os), MemberBinding.Problem("fox", path, os));
        Assert.Equal(Wrong(Root, os), MemberBinding.Problem("fox", @"C:\" + new string('a', 1022), os)); Assert.Null(MemberBinding.Problem("fox", @"C:\" + new string('a', 1021), os));
        Assert.Contains("ドライブから始まる", Wrong(Root, os)); Assert.Contains("「/」で始まる", Wrong(Root));
        Assert.Equal("フォルダを入れてください。端末で席が起動する場所です。", MemberBinding.Problem("fox", "", os)); Assert.Equal(Wrong(Pair), MemberBinding.Problem("", @"C:\x", os));
    }

    // ---- prefill ----
    [Theory]
    [InlineData("macos", "/Users/kite/BellTeam/ハル")]
    [InlineData("linux", "/home/kite/BellTeam/ハル")]
    [InlineData("windows", @"C:\Users\kite\BellTeam\ハル")]
    [InlineData("freebsd", "/Users/kite/BellTeam/ハル")]
    public void ThePrefillIsTheTerminalUsersHomeInTheTerminalsOwnForm(string os, string expected)
    {
        Assert.Equal(expected, MemberFolder.DefaultPath("kite", "  ハル ", os));
        Assert.Equal(expected, MemberFolder.Prefill("", null, "kite", "ハル", os));
    }

    [Fact]
    public void TheSlugReplacesPathCharactersAndFallsBackToMember()
    {
        Assert.Equal("/Users/k/BellTeam/a-b-c-d", MemberFolder.DefaultPath("k", "a/b\\c:d"));
        foreach (var name in new[] { "", "  ", ".", "..", " .. " }) Assert.Equal(@"C:\Users\k\BellTeam\member", MemberFolder.DefaultPath("k", name, "windows"));
        Assert.Equal(@"C:\Users\k\BellTeam\a-b", MemberFolder.DefaultPath("k", "a:b", "windows"));
    }

    [Fact]
    public void ThePrefillFollowsOnlyWhileTheFieldIsEmptyOrStillTheLastPrefill()
    {
        Assert.Null(MemberFolder.Prefill("/Users/kite/BellTeam/ハル", null, "kite", "ハル"));
        Assert.Equal("/Users/kite/BellTeam/ナギ", MemberFolder.Prefill("/Users/kite/BellTeam/ハル", "/Users/kite/BellTeam/ハル", "kite", "ナギ"));
        Assert.Equal(@"C:\Users\kite\BellTeam\ハル", MemberFolder.Prefill("/Users/kite/BellTeam/ハル", "/Users/kite/BellTeam/ハル", "kite", "ハル", "windows"));
        Assert.Null(MemberFolder.Prefill("/typed/by/the/owner", "/Users/kite/BellTeam/ハル", "kite", "ナギ"));
        Assert.Null(MemberFolder.Prefill("/Users/kite/BellTeam/ハル", "/Users/kite/BellTeam/ハル", "kite", "ハル"));
    }

    // ---- picker name rules and paths ----
    [Theory]
    [InlineData("", "macos", "フォルダの名前を入れてください。")]
    [InlineData("   ", "macos", "フォルダの名前を入れてください。")]
    [InlineData("a/b", "macos", "名前に「/」は使えません。")]
    [InlineData(@"a\b", "linux", @"名前に「\」は使えません。")]
    [InlineData(".", "macos", "「.」と「..」は名前にできません。")]
    [InlineData(" .. ", "windows", "「.」と「..」は名前にできません。")]
    [InlineData("a:b", "windows", "名前に「:」は使えません。")]
    [InlineData("a\0b", "macos", "名前に使えない文字があります。")]
    public void FolderNamesThatCannotBeSentAreStoppedWithASentence(string raw, string os, string problem) => Assert.Equal(problem, TerminalFolderPicker.Name(raw, os).Problem);

    [Fact]
    public void ColonIsAWindowsOnlyProblemAndTheNameIsTrimmedAndCappedAt255Bytes()
    {
        Assert.Equal(("a:b", null), TerminalFolderPicker.Name(" a:b ", "macos")); Assert.Equal(("a:b", null), TerminalFolderPicker.Name("a:b", "linux"));
        Assert.Equal(("新しい", null), TerminalFolderPicker.Name("  新しい\n", "windows"));
        Assert.Null(TerminalFolderPicker.Name(new string('a', 255)).Problem); Assert.Null(TerminalFolderPicker.Name(new string('あ', 85)).Problem);
        Assert.Equal("名前が長すぎます（255バイトまで）。", TerminalFolderPicker.Name(new string('a', 256)).Problem); Assert.Equal("名前が長すぎます（255バイトまで）。", TerminalFolderPicker.Name(new string('あ', 86)).Problem);
    }

    [Theory]
    [InlineData("/Users/kite", "work", "macos", "/Users/kite/work")]
    [InlineData("/", "work", "linux", "/work")]
    [InlineData(@"C:\Users\kite", "work", "windows", @"C:\Users\kite\work")]
    [InlineData(@"C:\", "work", "windows", @"C:\work")]
    [InlineData(@"C:\Users\kite", "work", "macos", @"C:\Users\kite/work")]
    public void ChildPathsAreJoinedWithTheTerminalsSeparator(string parent, string name, string os, string expected) => Assert.Equal(expected, TerminalFolderPicker.ChildPath(parent, name, os));

    [Fact]
    public async Task TheFolderReadEscapesTheQueryAndTheCreateIsOnePostWithPathAndCreate()
    {
        var seen = new List<(string Method, string Url, string Body)>();
        using var api = new BellApi(new("http://localhost/"), new StubHandler(async (request, token) =>
        {
            seen.Add((request.Method.Method, request.RequestUri!.PathAndQuery, request.Content is null ? "" : await request.Content.ReadAsStringAsync(token)));
            return request.Method == HttpMethod.Get ? StubHandler.Json("""{"path":"/h","entries":null,"truncated":null}""") : StubHandler.Json("""{"path":"/h/n","reason":null}""");
        }));
        var terminals = new TerminalsApi(api);
        var home = await terminals.FoldersAsync("owner-mac", null);
        await terminals.FoldersAsync("owner-mac", "/Users/k+1/a&b#c d/日本語"); await terminals.FoldersAsync("fox", @"C:\Users\kite_");
        Assert.Null(home.Entries); Assert.Null(home.Truncated);
        Assert.Equal("/api/terminals/owner-mac/folders", seen[0].Url);
        Assert.Equal("/api/terminals/owner-mac/folders?path=/Users/k%2B1/a%26b%23c%20d/%E6%97%A5%E6%9C%AC%E8%AA%9E", seen[1].Url);
        Assert.Equal("/api/terminals/fox/folders?path=C%3A%5CUsers%5Ckite_", seen[2].Url);
        Assert.All(seen, call => Assert.Equal("GET", call.Method));
        await terminals.CreateFolderAsync("fox", @"C:\Users\kite_\新");
        Assert.Equal(("POST", "/api/terminals/fox/folder"), (seen[3].Method, seen[3].Url));
        using var body = JsonDocument.Parse(seen[3].Body);
        Assert.Equal(["path", "create"], body.RootElement.EnumerateObject().Select(property => property.Name).ToArray());
        Assert.Equal(@"C:\Users\kite_\新", body.RootElement.GetProperty("path").GetString()); Assert.True(body.RootElement.GetProperty("create").GetBoolean());
    }

    // ---- the picker's state ----
    private static TerminalFolders Place(string path, string? parent = null, params string[] names) => new() { Path = path, Parent = parent, Entries = names.Select(name => new TerminalFolderEntry { Name = name, Path = path.TrimEnd('\\', '/') + (path.Contains('\\') ? "\\" : "/") + name }).ToArray() };

    [Theory]
    [InlineData("macos", "/Users/kite/work", "/Users/kite/work/新")]
    [InlineData("linux", "/home/kite", "/home/kite/新")]
    [InlineData("windows", @"C:\Users\kite", @"C:\Users\kite\新")]
    [InlineData("windows", @"C:\", @"C:\新")]
    public async Task CreatingSendsOnePostWithTheJoinedPathThenListsTheCurrentPlaceAndOpensTheNewFolder(string os, string directory, string created)
    {
        var posted = new List<string>(); var reads = new List<string?>();
        var model = new TerminalFolderPickerModel(os, (path, _) => { reads.Add(path); return Task.FromResult(Place(path ?? directory)); }, (path, _) => { posted.Add(path); return Task.FromResult(new TerminalFolderStatus()); });
        await model.OpenAsync(directory); model.NewName = " 新 "; await model.CreateFolderAsync();
        Assert.Equal([created], posted); Assert.Equal([directory, directory, created], reads);
        Assert.Equal(created, model.Listed!.Path); Assert.Equal("", model.NewName); Assert.Null(model.CreateNote); Assert.False(model.Creating);
    }

    [Fact]
    public async Task AFolderNameThatCannotBeSentSendsNothing()
    {
        var posted = 0;
        var model = new TerminalFolderPickerModel("windows", (path, _) => Task.FromResult(Place(path ?? @"C:\Users\kite")), (_, _) => { posted++; return Task.FromResult(new TerminalFolderStatus()); });
        await model.OpenAsync(null);
        foreach (var name in new[] { "", "a:b", "a/b", @"a\b", "..", "." }) { model.NewName = name; await model.CreateFolderAsync(); Assert.NotNull(model.CreateNote); }
        Assert.Equal(0, posted); Assert.Equal("新しい", TerminalFolderPicker.Name("新しい", "windows").Name);
    }

    [Fact]
    public async Task ALostCreateAnswerIsNeverSentAgainAndTheCurrentPlaceIsListedWithTheNote()
    {
        var posted = 0; var reads = new List<string?>();
        var model = new TerminalFolderPickerModel("macos", (path, _) => { reads.Add(path); return Task.FromResult(Place(path ?? "/Users/kite")); }, (_, _) => { posted++; throw new HttpRequestException("切れました。"); });
        await model.OpenAsync(null); model.NewName = "n"; await model.CreateFolderAsync();
        Assert.Equal(1, posted); Assert.Equal([null, "/Users/kite"], reads);
        Assert.Equal(TerminalFolderPicker.CreateFailedText, model.CreateNote); Assert.Equal("n", model.NewName); Assert.Equal("/Users/kite", model.Listed!.Path);
        await model.ReloadAsync(); Assert.Equal(1, posted);
    }

    [Fact]
    public async Task ARefusedCreateStaysInPlaceWithTheServersSentenceAndKeepsTheName()
    {
        var reads = new List<string?>();
        var model = new TerminalFolderPickerModel("macos", (path, _) => { reads.Add(path); return Task.FromResult(Place(path ?? "/Users/kite")); }, (_, _) => Task.FromResult(new TerminalFolderStatus { Reason = "FOLDER_NOT_WRITABLE", Action = "書き込めません。" }));
        await model.OpenAsync(null); model.NewName = "n"; await model.CreateFolderAsync();
        Assert.Equal("書き込めません。", model.CreateNote); Assert.Equal("n", model.NewName); Assert.Equal([null], reads);
    }

    [Fact]
    public async Task OnlyTheNewestReadWritesTheContentAndTheFailuresAreWorded()
    {
        var gates = new Dictionary<string, TaskCompletionSource<TerminalFolders>> { ["/a"] = new(), ["/b"] = new() };
        var model = new TerminalFolderPickerModel("macos", (path, _) => gates[path!].Task, (_, _) => Task.FromResult(new TerminalFolderStatus()));
        var first = model.OpenAsync("/a"); var second = model.OpenAsync("/b");
        gates["/b"].SetResult(Place("/b")); await second; gates["/a"].SetResult(Place("/a")); await first;
        Assert.Equal("/b", model.Listed!.Path);
        async Task<TerminalFolderPickerModel> Failing(Exception error) { var failing = new TerminalFolderPickerModel("macos", (_, _) => throw error, (_, _) => Task.FromResult(new TerminalFolderStatus())); await failing.OpenAsync(null); return failing; }
        var network = await Failing(new HttpRequestException("切れました。")); Assert.Equal((FolderContent.Failed, TerminalFolderPicker.ReadFailedText), (network.Content, network.FailedText));
        var server = await Failing(new BellApiException("x", HttpStatusCode.ServiceUnavailable, "TERMINALS_UNAVAILABLE")); Assert.Equal(TerminalFolderPicker.ReadFailedText, server.FailedText);
        var gone = await Failing(new BellApiException("x", HttpStatusCode.NotFound, "TERMINAL_NOT_FOUND")); Assert.Equal((FolderContent.Failed, "この端末は登録されていません。"), (gone.Content, gone.FailedText));
        var old = await Failing(new BellApiException("x", HttpStatusCode.NotFound)); Assert.Equal(FolderContent.Unsupported, old.Content);
    }

    // ---- unsupported detection ----
    [Fact]
    public async Task ABellTeamWithoutTheFoldersRouteIsA404ThatIsNotTerminalNotFoundOr405AndTheNextGoodReadClearsIt()
    {
        Assert.True(TerminalErrorText.IsFoldersUnsupported(new BellApiException("x", HttpStatusCode.NotFound))); Assert.True(TerminalErrorText.IsFoldersUnsupported(new BellApiException("x", HttpStatusCode.NotFound, "NOT_FOUND")));
        Assert.True(TerminalErrorText.IsFoldersUnsupported(new BellApiException("x", HttpStatusCode.MethodNotAllowed)));
        Assert.False(TerminalErrorText.IsFoldersUnsupported(new BellApiException("x", HttpStatusCode.NotFound, "TERMINAL_NOT_FOUND")));
        Assert.False(TerminalErrorText.IsFoldersUnsupported(new BellApiException("x", HttpStatusCode.ServiceUnavailable, "TERMINALS_UNAVAILABLE"))); Assert.False(TerminalErrorText.IsFoldersUnsupported(new HttpRequestException("x")));
        var answer = HttpStatusCode.NotFound; var code = "NOT_FOUND";
        using var api = new BellApi(new("http://localhost/"), new StubHandler((_, _) => Task.FromResult(answer == HttpStatusCode.OK ? StubHandler.Json("""{"path":"/h"}""") : StubHandler.Json($$"""{"error":"{{code}}"}""", answer))));
        var old = new TerminalsModel(new TerminalsApi(api)); var changes = 0; old.Changed += () => changes++;
        await Assert.ThrowsAsync<BellApiException>(() => old.FoldersAsync("t", null)); Assert.True(old.FoldersUnsupported); Assert.Equal(1, changes);
        await Assert.ThrowsAsync<BellApiException>(() => old.FoldersAsync("t", null)); Assert.Equal(1, changes);
        answer = HttpStatusCode.OK; await old.FoldersAsync("t", null); Assert.False(old.FoldersUnsupported);
        answer = HttpStatusCode.NotFound; code = "TERMINAL_NOT_FOUND";
        var unknown = new TerminalsModel(new TerminalsApi(api)); await Assert.ThrowsAsync<BellApiException>(() => unknown.FoldersAsync("t", null)); Assert.False(unknown.FoldersUnsupported);
        answer = HttpStatusCode.MethodNotAllowed; var notAllowed = new TerminalsModel(new TerminalsApi(api)); await Assert.ThrowsAsync<BellApiException>(() => notAllowed.FoldersAsync("t", null)); Assert.True(notAllowed.FoldersUnsupported);
    }

    // ---- FOLDER_* sentences ----
    [Theory]
    [InlineData("macos", "このフォルダはMacにありません。作るか、あるフォルダを選んでください")]
    [InlineData("windows", "このフォルダはWindows PCにありません。作るか、あるフォルダを選んでください")]
    [InlineData("linux", "このフォルダはLinuxマシンにありません。作るか、あるフォルダを選んでください")]
    public void FolderMissingIsWordedPerOsNamesTheFormsFolderAndAloneOffersCreate(string os, string words)
    {
        var refusal = MemberFolder.Refusal("FOLDER_MISSING", @"C:\Users\kite\BellTeam\ハル", os)!;
        Assert.Equal($@"{words}（C:\Users\kite\BellTeam\ハル）。", refusal.Text); Assert.True(refusal.OffersCreate);
    }

    [Fact]
    public void EveryOtherRefusalHasItsSentenceAndOffersNothing()
    {
        Assert.Equal(("これはファイルです。フォルダを選んでください（/f）。", false), Pair2(MemberFolder.Refusal("FOLDER_NOT_DIRECTORY", "/f")!));
        Assert.Equal(("このMacのユーザーが書き込めるフォルダを選んでください（/f）。", false), Pair2(MemberFolder.Refusal("FOLDER_NOT_WRITABLE", "/f")!));
        Assert.Equal(("このWindows PCのユーザーが書き込めるフォルダを選んでください（/f）。", false), Pair2(MemberFolder.Refusal("FOLDER_NOT_WRITABLE", "/f", "windows")!));
        Assert.Equal(("Macがこのフォルダを開かせてくれません。デスクトップ・書類・ダウンロードの外を選ぶか、リモートログインの「リモートユーザにフルディスクアクセスを許可」をオンにしてください（/f）。", false), Pair2(MemberFolder.Refusal("FOLDER_NOT_PERMITTED", "/f")!));
        Assert.Equal(("Windows PCがこのフォルダを開かせてくれません。このWindows PCのユーザーが開けるフォルダを選んでください（/f）。", false), Pair2(MemberFolder.Refusal("FOLDER_NOT_PERMITTED", "/f", "windows")!));
        Assert.Contains("Linuxマシンがこのフォルダを開かせてくれません。", MemberFolder.Refusal("FOLDER_NOT_PERMITTED", "/f", "linux")!.Text);
        Assert.Equal(("このフォルダは使えません（/f）。", false), Pair2(MemberFolder.Refusal("FOLDER_SOMETHING_NEW", "/f")!));
        Assert.Equal(("この端末は登録されていません。", false), Pair2(MemberFolder.Refusal("TERMINAL_NOT_FOUND", "/f")!));
        Assert.Null(MemberFolder.Refusal("BOT_UPDATE_CONFLICT", "/f")); Assert.Null(MemberFolder.Refusal(null, "/f"));
        static (string, bool) Pair2(MemberFolderRefusal refusal) => (refusal.Text, refusal.OffersCreate);
    }

    [Fact]
    public void ThePickersSentencesKeepTheServersActionAndNeverReadAnUnreachableTerminalAsAnEmptyList()
    {
        Assert.Equal("いまこの端末に届きません。Windows PCが起きていて同じネットワークにあるか確かめて、もう一度お試しください。", TerminalFolderPicker.Sentence("UNREACHABLE", "ssh timed out", "windows"));
        Assert.Equal(TerminalFolderPicker.UnreachableText(), TerminalFolderPicker.Sentence("REMOTE_AITERM_TIMEOUT", null)); Assert.Equal(TerminalFolderPicker.UnreachableText(), TerminalFolderPicker.Sentence("CONNECTION_LOST", null));
        Assert.Equal("サーバーの一文。", TerminalFolderPicker.Sentence("SOMETHING_ELSE", " サーバーの一文。 "));
        Assert.Equal("このフォルダはMacにありません。作るか、あるフォルダを選んでください。", TerminalFolderPicker.Sentence("FOLDER_MISSING", null));
        Assert.Equal("この端末は登録されていません。", TerminalFolderPicker.Sentence("TERMINAL_NOT_FOUND", "x"));
        Assert.Equal("Windows PCがこのフォルダを開かせてくれません。このWindows PCのユーザーが開けるフォルダを選んでください。", TerminalFolderPicker.Sentence("FOLDER_NOT_PERMITTED", "ignored", "windows"));
    }

    // ---- what the editor sends ----
    private const string Bell = """{"id":"bot-bell","name":"ベル","harness":"codex","model":"test-fast","terminalId":"owner-mac","projectRoot":"/Users/kite/work/app"}""";
    private const string BellOld = """{"id":"bot-bell","name":"ベル","harness":"codex","model":"test-fast"}""";
    private const string TerminalList = """{"terminals":[{"terminalId":"owner-mac","host":"192.168.1.12","user":"kite","os":"macos"},{"terminalId":"fox","host":"192.168.1.11","user":"kite_","os":"windows"}]}""";
    private static readonly ModelsResponse Catalog = new() { Models = new() { ["codex"] = new() { DefaultModel = "test-fast", Efforts = ["high"], Models = [new() { Id = "test-fast", Efforts = ["high"], Fast = true }] } } };

    // A server for one bot: its profile, the terminal list (null = no route) and the writes it was sent (method, path, body).
    private sealed class Server(string bot, string? terminals = TerminalList)
    {
        public readonly List<(string Method, string Path, JsonElement Body)> Writes = [];
        public readonly Queue<(HttpStatusCode Status, string Json)> Answers = [];
        // The folder reads it was asked (path and query).
        public readonly List<string> FolderReads = [];
        public Workspace Open() => new(origin => new BellApi(origin, new StubHandler(async (request, token) =>
        {
            var path = request.RequestUri!.AbsolutePath;
            if (path.EndsWith("/folders", StringComparison.Ordinal)) { FolderReads.Add(request.RequestUri.PathAndQuery); return StubHandler.Json("""{"home":"/Users/kite","path":"/Users/kite","parent":"/Users","entries":[{"name":"work","path":"/Users/kite/work"}]}"""); }
            if (request.Method != HttpMethod.Get)
            {
                Writes.Add((request.Method.Method, path, JsonDocument.Parse(await request.Content!.ReadAsStringAsync(token)).RootElement.Clone()));
                var (status, json) = Answers.Count > 0 ? Answers.Dequeue() : (HttpStatusCode.OK, $$"""{"bot":{{bot}}}""");
                return StubHandler.Json(json, status);
            }
            return StubHandler.Json(path switch
            {
                "/api/session" => """{"authenticated":true,"authMode":"local"}""", "/api/bots" => """{"bots":[{"id":"bot-bell","name":"ベル","displayName":"ベル","harness":"codex"}]}""", "/api/owner" => ApiTests.Owner, "/api/queue" => ApiTests.EmptyQueue, "/api/rooms" => ApiTests.Rooms,
                "/api/models" => JsonSerializer.Serialize(Catalog, BellApi.Json), "/api/bots/bot-bell" => $$"""{"bot":{{bot}}}""", "/api/terminals" when terminals is not null => terminals, _ => terminals is null && path == "/api/terminals" ? """{"error":"NOT_FOUND"}""" : ApiTests.Page
            }, path == "/api/terminals" && terminals is null ? HttpStatusCode.NotFound : HttpStatusCode.OK);
        })));
    }
    private static MemberEditorView Open(Workspace workspace, string? id) { Await(workspace.ConnectAsync("http://localhost", listen: false)); var editor = new MemberEditorView(workspace, id); Await(editor.InitializeAsync()); Await(editor.ReadyTask); return editor; }

    [Fact]
    public void ANewMemberSendsBothEmptyOnAServerThatListsTerminalsAndNeitherOtherwise()
    {
        RunSta(() =>
        {
            foreach (var supported in new[] { true, false })
            {
                var server = new Server(BellOld, supported ? TerminalList : null); using var workspace = server.Open(); var editor = Open(workspace, null);
                Named<TextBox>(editor, "名前").Text = "新人"; Await(editor.SaveAsync());
                var (method, path, body) = Assert.Single(server.Writes); Assert.Equal(("POST", "/api/bots"), (method, path));
                Assert.Equal(supported, body.TryGetProperty("terminalId", out var terminalId)); Assert.Equal(supported, body.TryGetProperty("projectRoot", out _)); Assert.False(body.TryGetProperty("createFolder", out _));
                if (supported) Assert.Equal("", terminalId.GetString());
                editor.Dispose();
            }
        });
    }

    [Fact]
    public void AnExistingMemberSendsTheBindingOnlyWhenItChangedOnASupportingServerAndNeverForAnOlderBody()
    {
        RunSta(() =>
        {
            var older = new Server(BellOld); using var oldWorkspace = older.Open(); var oldEditor = Open(oldWorkspace, "bot-bell");
            Assert.Contains(Texts(oldEditor), text => text.Text == "このBellTeamはまだメンバーの端末設定に対応していません");
            Named<TextBox>(oldEditor, "役職").Text = "相談役"; Await(oldEditor.SaveAsync());
            Assert.Equal(["position"], Assert.Single(older.Writes).Body.EnumerateObject().Select(property => property.Name).ToArray()); oldEditor.Dispose();

            var server = new Server(Bell); using var workspace = server.Open(); var editor = Open(workspace, "bot-bell");
            Named<TextBox>(editor, "役職").Text = "相談役"; Await(editor.SaveAsync()); Assert.Equal(["position"], Assert.Single(server.Writes).Body.EnumerateObject().Select(property => property.Name).ToArray());
            // A moved binding travels with both fields; the old folder is a typed value, so the new terminal does not prefill over it.
            editor.Terminal.Picker.SelectedValue = "fox"; Assert.Equal("/Users/kite/work/app", editor.Terminal.ProjectRoot);
            editor.Terminal.TypedPath.Text = @"C:\work\app"; Await(editor.SaveAsync());
            var body = server.Writes[^1].Body; Assert.Equal(["terminalId", "projectRoot"], body.EnumerateObject().Select(property => property.Name).ToArray());
            Assert.Equal(("fox", @"C:\work\app"), (body.GetProperty("terminalId").GetString(), body.GetProperty("projectRoot").GetString()));
            editor.Dispose();
        });
    }

    [Fact]
    public void ANewTerminalPrefillsTheFolderInItsOwnFormAndAnOlderBodyIsNeverToldAboutFolders()
    {
        RunSta(() =>
        {
            var server = new Server(BellOld); using var workspace = server.Open(); var editor = Open(workspace, null);
            Named<TextBox>(editor, "名前").Text = "ハル"; editor.Terminal.Picker.SelectedValue = "fox";
            Assert.Equal(@"C:\Users\kite_\BellTeam\ハル", editor.Terminal.ProjectRoot);
            editor.Terminal.Picker.SelectedValue = "owner-mac"; Assert.Equal("/Users/kite/BellTeam/ハル", editor.Terminal.ProjectRoot);
            Named<TextBox>(editor, "名前").Text = "ナギ"; Assert.Equal("/Users/kite/BellTeam/ナギ", editor.Terminal.ProjectRoot);
            editor.Terminal.TypedPath.Text = "/typed"; Named<TextBox>(editor, "名前").Text = "ミカ"; Assert.Equal("/typed", editor.Terminal.ProjectRoot);
            editor.Terminal.Picker.SelectedValue = ""; Assert.Equal(("", ""), (editor.Terminal.TerminalId, editor.Terminal.ProjectRoot));
            editor.Dispose();
        });
    }

    [Fact]
    public void ARefusedBindingIsWordedPerCodeAndOnlyFolderMissingOffersTheCreateThatIsSentOnThatSaveAlone()
    {
        RunSta(() =>
        {
            var server = new Server(Bell); using var workspace = server.Open(); var editor = Open(workspace, "bot-bell");
            editor.Terminal.TypedPath.Text = "/Users/kite/new/place";
            server.Answers.Enqueue((HttpStatusCode.Conflict, """{"error":"FOLDER_NOT_WRITABLE"}""")); Await(editor.SaveAsync());
            Assert.Equal("このMacのユーザーが書き込めるフォルダを選んでください（/Users/kite/new/place）。", editor.ErrorText); Assert.False(editor.OffersCreateFolder);
            server.Answers.Enqueue((HttpStatusCode.Conflict, """{"error":"FOLDER_MISSING"}""")); Await(editor.SaveAsync());
            Assert.Equal("このフォルダはMacにありません。作るか、あるフォルダを選んでください（/Users/kite/new/place）。", editor.ErrorText); Assert.True(editor.OffersCreateFolder);
            Assert.Contains(Texts(editor), text => text.Text == "このフォルダを作って保存");
            Assert.All(server.Writes, write => Assert.False(write.Body.TryGetProperty("createFolder", out _)));
            // Editing the form drops the offer; the folder it named is no longer the form's.
            editor.Terminal.TypedPath.Text = "/Users/kite/new/place2"; Assert.False(editor.OffersCreateFolder); Assert.DoesNotContain(Texts(editor), text => text.Text == "このフォルダを作って保存");
            Await(editor.SaveAsync()); Assert.False(server.Writes[^1].Body.TryGetProperty("createFolder", out _));
            editor.Terminal.TypedPath.Text = "/Users/kite/new/place3"; server.Answers.Enqueue((HttpStatusCode.Conflict, """{"error":"FOLDER_MISSING"}""")); Await(editor.SaveAsync()); Assert.True(editor.OffersCreateFolder);
            Await(editor.CreateFolderAndSaveAsync());
            var create = server.Writes[^1].Body; Assert.True(create.GetProperty("createFolder").GetBoolean()); Assert.Equal("/Users/kite/new/place3", create.GetProperty("projectRoot").GetString()); Assert.Equal(["projectRoot", "createFolder"], create.EnumerateObject().Select(property => property.Name).ToArray());
            Assert.False(editor.OffersCreateFolder); editor.Dispose();
        });
    }

    [Fact]
    public void ABindingThatBreaksTheRulesIsNeverSentAndSaysWhy()
    {
        RunSta(() =>
        {
            var server = new Server(Bell); using var workspace = server.Open(); var editor = Open(workspace, "bot-bell");
            editor.Terminal.TypedPath.Text = "relative/path"; Await(editor.SaveAsync()); Assert.Empty(server.Writes); Assert.Equal(Wrong(Root), editor.ErrorText);
            Assert.Contains(Texts(editor), text => text.Text == Wrong(Root));
            editor.Terminal.Picker.SelectedValue = "fox"; editor.Terminal.TypedPath.Text = "/Users/kite"; Await(editor.SaveAsync()); Assert.Empty(server.Writes); Assert.Equal(Wrong(Root, "windows"), editor.ErrorText);
            editor.Dispose();
        });
    }

    [Fact]
    public void ThePickerOpensAtTheHomeOpensSubfoldersAndChoosingWritesTheReadOnlyFieldWithoutSendingAnything()
    {
        RunSta(() =>
        {
            var server = new Server(Bell); using var workspace = server.Open(); var editor = Open(workspace, "bot-bell");
            Assert.Equal("/Users/kite/work/app", editor.Terminal.ProjectRoot); Assert.Contains(Texts(editor), text => text.Text == "/Users/kite/work/app");
            Click(editor, "フォルダを選ぶ"); Await(editor.PickerLoad);
            Assert.Equal(["/api/terminals/owner-mac/folders"], server.FolderReads); Assert.NotNull(editor.Picker);
            Assert.Contains(Texts(editor.Picker!), text => text.Text == "/Users/kite"); Assert.Contains(Texts(editor.Picker!), text => text.Text == "新しいフォルダ");
            Click(editor.Picker!, "work"); Await(editor.Picker!.Model.ReloadAsync());
            Assert.Equal(["/api/terminals/owner-mac/folders", "/api/terminals/owner-mac/folders?path=/Users/kite/work"], server.FolderReads.Take(2).ToArray());
            Click(editor.Picker!, "このフォルダにする");
            Assert.Null(editor.Picker); Assert.Equal("/Users/kite", editor.Terminal.ProjectRoot); Assert.Empty(server.Writes);
            editor.Dispose();
        });
    }

    // ---- helpers ----
    private static void Click(DependencyObject root, string name) => Descendants<UIElement>(root).First(item => System.Windows.Automation.AutomationProperties.GetName(item) == name)
        .RaiseEvent(new System.Windows.Input.MouseButtonEventArgs(System.Windows.Input.Mouse.PrimaryDevice, 0, System.Windows.Input.MouseButton.Left) { RoutedEvent = UIElement.MouseLeftButtonUpEvent });
    private static IEnumerable<TextBlock> Texts(DependencyObject root) => Descendants<TextBlock>(root);
    private static IEnumerable<Button> Buttons(DependencyObject root) => Descendants<Button>(root);
    private static T Named<T>(DependencyObject root, string name) where T : DependencyObject => Descendants<T>(root).Single(item => System.Windows.Automation.AutomationProperties.GetName(item) == name);
    private static IEnumerable<T> Descendants<T>(DependencyObject root) where T : DependencyObject { if (root is T found) yield return found; foreach (var child in LogicalTreeHelper.GetChildren(root).OfType<DependencyObject>()) foreach (var item in Descendants<T>(child)) yield return item; }
    private static void Pump() { var frame = new DispatcherFrame(); Dispatcher.CurrentDispatcher.BeginInvoke(DispatcherPriority.Background, new Action(() => frame.Continue = false)); Dispatcher.PushFrame(frame); }
    private static void Await(Task task) { var until = DateTime.UtcNow.AddSeconds(5); while (!task.IsCompleted) { if (DateTime.UtcNow > until) throw new TimeoutException(); Pump(); Thread.Sleep(1); } task.GetAwaiter().GetResult(); }
    private static void RunSta(Action action)
    {
        Exception? failure = null; var thread = new Thread(() => { try { SynchronizationContext.SetSynchronizationContext(new DispatcherSynchronizationContext(Dispatcher.CurrentDispatcher)); action(); } catch (Exception error) { failure = error; } finally { Dispatcher.CurrentDispatcher.InvokeShutdown(); } });
        thread.SetApartmentState(ApartmentState.STA); thread.Start(); thread.Join(); if (failure is not null) System.Runtime.ExceptionServices.ExceptionDispatchInfo.Capture(failure).Throw();
    }
}
