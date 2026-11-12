using System.Net;
using System.Net.Http;
using System.Text.Json;
using BellTeam.App;
using BellTeam.Core;

namespace BellTeam.Tests;

public sealed class GoalTests
{
    private static string Snapshot(string bot = "bot-a", string availability = "available", string caps = "\"inspect\":true,\"create\":false,\"edit\":true,\"pause\":true,\"resume\":false,\"clear\":true",
        string? goal = "null", string extra = "", string fields = "{\"objective\":true,\"tokenBudget\":true,\"combined\":true}")
        => $$"""{"botId":"{{bot}}","availability":"{{availability}}","capabilities":{ {{caps}} },"fieldCapabilities":{"create":{{fields}},"edit":{{fields}}},"binding":{"sessionId":"s","launchId":"l","threadId":"t"},"observedAt":"2026-11-08T03:00:00Z","message":null{{(goal is null ? "" : ",\"goal\":" + goal)}}{{extra}} }""";
    private static string Codex(string status, string extra = "") => $$"""{"kind":"codex-cli","native":{"threadId":"t","objective":"仕様をまとめる","status":"{{status}}","tokenBudget":50000,"tokensUsed":1234,"timeUsedSeconds":61.5,"createdAt":1,"updatedAt":2{{extra}} },"unknownKind":1}""";
    private static GoalSnapshot Parse(string json) { using var document = JsonDocument.Parse(json); return GoalParser.ParseSnapshot(document.RootElement.Clone()); }

    [Theory]
    [InlineData("active", "進行中")]
    [InlineData("paused", "一時停止")]
    [InlineData("blocked", "進行できない状態")]
    [InlineData("usageLimited", "利用制限")]
    [InlineData("budgetLimited", "予算に到達")]
    [InlineData("complete", "完了")]
    public void CodexStatusTitlesFollowTheMac(string status, string title)
    {
        var snapshot = Parse(Snapshot(goal: Codex(status)));
        Assert.Equal(title, snapshot.StatusTitle);
        Assert.Equal("使用量 1,234 / 予算 50,000 · 作業時間 61.5秒", snapshot.Goal!.UsageText);
        Assert.Equal("61.5秒", snapshot.PillElapsed);
        Assert.Equal(status == "active", snapshot.Goal.IsActive);
        Assert.Equal(status == "paused", snapshot.Goal.IsPaused);
    }

    [Fact]
    public void ParsesEveryNativeKindAndIgnoresUnknownFields()
    {
        var legacy = Parse(Snapshot(goal: """{"objective":"古い形","status":"active","tokenBudget":null,"tokensUsed":0,"timeUsedSeconds":3}""", extra: ",\"somethingNew\":{\"a\":1}"));
        Assert.Equal("使用量 0 / 予算 指定なし · 作業時間 3秒", legacy.Goal!.UsageText);
        Assert.Null(legacy.Goal.TokenBudget);

        var claude = Parse(Snapshot(goal: """{"kind":"claude-code","phase":"active","native":{"type":"goal_status","condition":"試験を通す","met":false,"tokens":1200,"durationMs":2500.5,"iterations":3},"reported_turns":4}""",
            extra: ""","nativeHistory":{"kind":"claude-code","terminal":"cleared","native":{"type":"goal_status","condition":"前の仕事","met":true,"sentinel":true}}"""));
        Assert.Equal("進行中", claude.StatusTitle);
        Assert.Equal("試験を通す", claude.Goal!.Objective);
        Assert.Equal("使用トークン 1,200 · 実行時間 2,500.5ミリ秒 · 反復数 3 · CLI表示ターン数 4", claude.Goal.UsageText);
        Assert.Equal("2,500.5ミリ秒", claude.PillElapsed);
        Assert.Equal("前のゴール：取消 · 前の仕事", claude.HistoryText);
        var bare = Parse(Snapshot(goal: """{"kind":"claude-code","phase":"active","native":{"type":"goal_status","condition":"x","met":false}}"""));
        Assert.Equal("使用量・作業時間はまだ取得していません。", bare.Goal!.UsageText);
        Assert.Equal("時間未取得", bare.PillElapsed);

        var grokStatus = Parse(Snapshot(goal: """{"kind":"grok-cli","native":{"objective":"画面を直す"},"current_status":{"source":"/goal status","status":"UserPaused","phase":"Planning","tokens_used":9876,"elapsed_display":"4m12s"}}"""));
        Assert.Equal("一時停止 · 計画中", grokStatus.StatusTitle);
        Assert.True(grokStatus.Goal!.IsPaused); Assert.False(grokStatus.Goal.IsActive);
        Assert.Equal("使用トークン 9,876 · 経過 4m12s", grokStatus.Goal.UsageText);
        var grokDetail = Parse(Snapshot(goal: """{"kind":"grok-cli","native":{"objective":"調べる"},"current_status":{"source":"goal detail","status":"Active","phase":null,"tokens_used":null,"status_display":"進行中(表示)","phase_display":null,"budget_display":"予算 1M","elapsed_display":"2m0s"}}"""));
        Assert.Equal("進行中(表示)", grokDetail.StatusTitle);
        Assert.Equal("予算 1M · 2m0s", grokDetail.Goal!.UsageText);
        Assert.True(grokDetail.Goal.IsActive);
    }

    [Theory]
    [InlineData("""{"kind":"unknown","native":{}}""")]
    [InlineData("""{"kind":"claude-code","phase":"active","native":{"type":"goal_status","condition":"x","met":true}}""")]
    [InlineData("""{"kind":"grok-cli","native":{"objective":"x"},"current_status":{"source":"/goal status","status":"Active","phase":"Idle","tokens_used":1,"elapsed_display":""}}""")]
    [InlineData("""{"kind":"codex-cli","native":{"objective":"x","status":"exploded","tokensUsed":1,"timeUsedSeconds":1}}""")]
    public void RejectsAGoalTheMacCannotDecode(string goal) => Assert.Throws<BellApiException>(() => Parse(Snapshot(goal: goal)));

    [Fact]
    public void RejectsASnapshotWithoutItsRequiredFields()
    {
        Assert.Throws<BellApiException>(() => Parse("""{"botId":"x"}"""));
        Assert.Throws<BellApiException>(() => Parse(Snapshot(availability: "gone")));
    }

    [Fact]
    public void ActionsFollowTheCapabilitiesAndTheStatus()
    {
        var active = Parse(Snapshot(goal: Codex("active")));
        Assert.True(active.CanEdit && active.CanPause && active.CanClear); Assert.False(active.CanResume); Assert.False(active.CanCreate);
        Assert.Empty(active.UnavailableActions);

        // 再開 is offered only to a paused goal that may resume; a paused goal without the capability is named in the note.
        var paused = Parse(Snapshot(goal: Codex("paused"), caps: "\"inspect\":true,\"create\":false,\"edit\":false,\"pause\":false,\"resume\":false,\"clear\":true"));
        Assert.False(paused.CanResume); Assert.False(paused.CanEdit); Assert.False(paused.CanPause);
        Assert.Equal(["編集", "再開"], paused.UnavailableActions);
        Assert.Contains("取り消すとゴールは消えます。", paused.PageFootnote); Assert.DoesNotContain("再開できます", paused.PageFootnote);

        var resumable = Parse(Snapshot(goal: Codex("paused"), caps: "\"inspect\":true,\"create\":false,\"edit\":true,\"pause\":false,\"resume\":true,\"clear\":false"));
        Assert.True(resumable.CanResume); Assert.False(resumable.CanPause); Assert.False(resumable.CanClear);
        Assert.Equal(["取り消し"], resumable.UnavailableActions);
        Assert.StartsWith("一時停止したゴールは再開できます。今の処理を中断するには", resumable.PageFootnote);

        var limited = Parse(Snapshot(goal: Codex("budgetLimited"), caps: "\"inspect\":true,\"create\":false,\"edit\":true,\"pause\":true,\"resume\":true,\"clear\":true"));
        Assert.False(limited.CanPause); Assert.False(limited.CanResume); // neither active nor paused

        var none = Parse(Snapshot(caps: "\"inspect\":true,\"create\":true,\"edit\":false,\"pause\":false,\"resume\":false,\"clear\":false"));
        Assert.True(none.CanCreate); Assert.True(none.HasAction); Assert.Equal("ゴールは設定されていません", none.StatusTitle); Assert.Null(none.PillElapsed);
        var closed = Parse(Snapshot(caps: "\"inspect\":true,\"create\":false,\"edit\":false,\"pause\":false,\"resume\":false,\"clear\":false"));
        Assert.False(closed.HasAction);
        var noField = Parse(Snapshot(caps: "\"inspect\":true,\"create\":true,\"edit\":false,\"pause\":false,\"resume\":false,\"clear\":false", fields: "{\"objective\":false,\"tokenBudget\":true,\"combined\":false}"));
        Assert.False(noField.CanCreate);
    }

    [Fact]
    public void UnavailableSnapshotsUseTheServerOrDefaultMessage()
    {
        Assert.Equal("このメンバーではゴール機能を使えません。", Parse(Snapshot(availability: "unsupported")).UnavailableMessage);
        Assert.Equal("ゴールの状態を取得できません。", Parse(Snapshot(availability: "unavailable")).UnavailableMessage);
        Assert.Equal("サーバーの文", Parse(Snapshot(availability: "unavailable").Replace("\"message\":null", "\"message\":\"サーバーの文\"")).UnavailableMessage);
    }

    [Fact]
    public void UnavailableReasonSeparatesAnIdleSeatFromAReadFailure()
    {
        var idle = Parse(Snapshot(availability: "unavailable", extra: ",\"reason\":\"seat_idle\""));
        Assert.True(idle.IsIdle); Assert.Equal("休止中です。メッセージを送ると再開します。", idle.UnavailableMessage);
        Assert.False(Parse(Snapshot(availability: "unavailable", extra: ",\"reason\":\"read_failed\"")).IsIdle);
        Assert.False(Parse(Snapshot(availability: "unavailable")).IsIdle); // no reason (older server) = read failure
        Assert.False(Parse(Snapshot(extra: ",\"reason\":null")).IsIdle);
    }

    private static readonly GoalFields Combined = new(true, true, true), Separate = new(true, true, false), None = new(false, false, false);
    private static GoalSnapshot Editing(GoalFields create, GoalFields edit, bool hasGoal = true, bool createCapable = true, bool editCapable = true)
        => new("bot-a", GoalAvailability.Available, new(true, createCapable, editCapable, true, false, true), new(create, edit), new("s", "l", "t"),
            hasGoal ? new CodexGoal("元の目的", "active", 5000, 1, 1) : null, null, null, null);

    [Fact]
    public void EditorShowsTheFieldsTheCapabilitiesAllow()
    {
        var snapshot = Editing(Combined, Separate);
        var edit = new GoalEditorModel(snapshot, "edit", "codex");
        Assert.True(edit.SeparateChoice(snapshot)); Assert.True(edit.EditsObjective(snapshot)); Assert.False(edit.EditsBudget(snapshot));
        Assert.Equal("元の目的", edit.Objective); Assert.Equal("5000", edit.Budget);
        edit.Field = GoalEditField.Budget;
        Assert.False(edit.EditsObjective(snapshot)); Assert.True(edit.EditsBudget(snapshot));
        Assert.True(new GoalEditorModel(snapshot, "edit", "codex").CodexResetNote(snapshot)); Assert.False(new GoalEditorModel(snapshot, "edit", "claude").CodexResetNote(snapshot));
        var create = new GoalEditorModel(Editing(Combined, Separate, hasGoal: false), "create", "codex");
        var creating = Editing(Combined, Separate, hasGoal: false);
        Assert.False(create.SeparateChoice(creating)); Assert.True(create.EditsObjective(creating)); Assert.True(create.EditsBudget(creating)); Assert.False(create.CodexResetNote(creating));
        Assert.Equal("", create.Objective); Assert.Equal("", create.Budget);
    }

    [Fact]
    public void SaveIsOnlyEnabledForAValidDraft()
    {
        var snapshot = Editing(Combined, Combined, hasGoal: false);
        var editor = new GoalEditorModel(snapshot, "create", "codex");
        Assert.False(editor.CanSave(snapshot, false, false)); // empty objective
        editor.Objective = "  \n ";
        Assert.False(editor.CanSave(snapshot, false, false));
        editor.Objective = "目的";
        Assert.True(editor.CanSave(snapshot, false, false));
        Assert.False(editor.CanSave(snapshot, saving: true, refreshing: false)); Assert.False(editor.CanSave(snapshot, false, refreshing: true));
        Assert.False(editor.CanSave(snapshot with { Binding = new("s", "l", "other") }, false, false)); Assert.True(editor.BindingChanged(snapshot with { Binding = null }));
        Assert.False(editor.CanSave(snapshot with { Availability = GoalAvailability.Unavailable }, false, false));
        Assert.False(editor.CanSave(Editing(Combined, Combined, hasGoal: false, createCapable: false), false, false));
        editor.Objective = new string('あ', 4000); Assert.True(editor.CanSave(snapshot, false, false)); Assert.Equal("4000 / 4000", editor.CountText);
        editor.Objective = new string('あ', 4001); Assert.False(editor.CanSave(snapshot, false, false));
        editor.Objective = "家族👨‍👩‍👧"; Assert.Equal("3 / 4000", editor.CountText); // characters, as Swift counts them
    }

    [Fact]
    public void BudgetOnlyEditNeedsAChangedPositiveInteger()
    {
        var snapshot = Editing(Separate, Separate);
        var editor = new GoalEditorModel(snapshot, "edit", "codex") { Field = GoalEditField.Budget };
        Assert.False(editor.CanSave(snapshot, false, false)); // unchanged
        editor.BudgetChanged = true; editor.Budget = "";
        Assert.False(editor.CanSave(snapshot, false, false));
        foreach (var bad in new[] { "0", "-3", "abc", "1.5", " 7" }) { editor.Budget = bad; Assert.False(editor.CanSave(snapshot, false, false), bad); }
        editor.Budget = "7500"; Assert.True(editor.CanSave(snapshot, false, false));
        var (objective, budget, error) = editor.Prepare(snapshot);
        Assert.Null(objective); Assert.Equal(7500, budget); Assert.Null(error);
    }

    [Fact]
    public void CombinedSaveReportsABadBudgetBeforeSendingAnything()
    {
        var snapshot = Editing(Combined, Combined, hasGoal: false);
        var editor = new GoalEditorModel(snapshot, "create", "codex") { Objective = "  目的 " };
        Assert.Equal(("目的", (long?)null, (string?)null), editor.Prepare(snapshot)); // an untouched budget is not sent
        editor.BudgetChanged = true; editor.Budget = "abc";
        Assert.True(editor.CanSave(snapshot, false, false)); // the objective is valid, so the button is on and the message appears on save
        Assert.Equal("トークン予算は1以上の整数で入力してください。", editor.Prepare(snapshot).Error);
        editor.Budget = "0"; Assert.NotNull(editor.Prepare(snapshot).Error);
        editor.Budget = ""; Assert.Equal(("目的", (long?)null, (string?)null), editor.Prepare(snapshot));
        editor.Budget = "9000"; Assert.Equal(("目的", (long?)9000, (string?)null), editor.Prepare(snapshot));
    }

    private sealed class Server
    {
        public List<(HttpMethod Method, string Path, string Body)> Calls { get; } = [];
        public Func<HttpRequestMessage, string, HttpResponseMessage>? Respond { get; set; }
        public GoalsApi Api() => new(new BellApi(new("http://localhost/"), new StubHandler(async (request, _) =>
        {
            var body = request.Content is null ? "" : await request.Content.ReadAsStringAsync();
            Calls.Add((request.Method, request.RequestUri!.AbsolutePath, body));
            return Respond!(request, body);
        })));
    }
    private static HttpResponseMessage List(params string[] snapshots) => StubHandler.Json("{\"goals\":[" + string.Join(',', snapshots) + "]}");
    private static HttpResponseMessage Detail(string snapshot) => StubHandler.Json("{\"snapshot\":" + snapshot + "}");
    private static HttpResponseMessage Changed(string outcome, string snapshot, HttpStatusCode status = HttpStatusCode.OK) => StubHandler.Json("{\"outcome\":\"" + outcome + "\",\"snapshot\":" + snapshot + "}", status);

    [Fact]
    public async Task ReadsTheListAndTheDetailWithGet()
    {
        var server = new Server { Respond = (request, _) => request.RequestUri!.AbsolutePath == "/api/goals" ? List(Snapshot("bot-a"), Snapshot("bot-b", availability: "unsupported")) : Detail(Snapshot("bot-a")) };
        var model = new GoalModel(server.Api());
        await model.LoadListAsync();
        Assert.True(model.Loaded); Assert.Equal(2, model.Snapshots.Count); Assert.Null(model.ErrorText);
        await model.LoadDetailAsync("bot-a");
        Assert.Single(model.Snapshots);
        Assert.All(server.Calls, call => Assert.Equal(HttpMethod.Get, call.Method));
        Assert.Equal(["/api/goals", "/api/bots/bot-a/goal"], server.Calls.Select(call => call.Path));
    }

    [Fact]
    public async Task AFailedReadHidesTheCardsAndTheNextSuccessClearsTheFailure()
    {
        var fail = true;
        var server = new Server { Respond = (_, _) => fail ? StubHandler.Json("{\"error\":\"TEMPORARY\"}", HttpStatusCode.ServiceUnavailable) : List(Snapshot()) };
        var model = new GoalModel(server.Api());
        await model.LoadListAsync();
        // Mac #1116: a failed read is the plain 確認できません state; ErrorText stays for a change's own sentence, the cause only in ReadError (folded 詳細).
        Assert.True(model.NeedsRefresh); Assert.False(model.Loaded); Assert.Null(model.ErrorText); Assert.NotNull(model.ReadError);
        Assert.Equal(GoalPillText.UnreadDetail, GoalPillText.Failure(model, "bot-a"));
        fail = false;
        await model.LoadListAsync(); // the next event or refresh reads again; nothing gave up
        Assert.False(model.NeedsRefresh); Assert.True(model.Loaded); Assert.Null(model.ErrorText); Assert.Null(model.ReadError); Assert.Single(model.CurrentSnapshots);
        fail = true;
        await model.LoadListAsync();
        Assert.True(model.NeedsRefresh); Assert.Empty(model.CurrentSnapshots); Assert.Single(model.Snapshots); // hidden, not forgotten
        Assert.Equal(3, server.Calls.Count);
    }

    [Fact]
    public async Task ADetailForAnotherBotIsRejected()
    {
        var server = new Server { Respond = (_, _) => Detail(Snapshot("bot-z")) };
        var model = new GoalModel(server.Api());
        await model.LoadDetailAsync("bot-a");
        Assert.True(model.NeedsRefresh); Assert.Null(model.ErrorText); Assert.Equal("ゴールの応答を確認できませんでした。更新して確認してください。", model.ReadError);
    }

    [Fact]
    public async Task AnUnreadableAnswerIsAFailureNotAnEmptyList()
    {
        var server = new Server { Respond = (_, _) => StubHandler.Json("{\"goals\":[{\"botId\":\"x\"}]}") };
        var model = new GoalModel(server.Api());
        await model.LoadListAsync();
        Assert.True(model.NeedsRefresh); Assert.Null(model.ErrorText); Assert.StartsWith("BellTeamからの応答を読み取れませんでした。", model.ReadError);
    }

    [Fact]
    public async Task AChangesOwnSentenceSurvivesALaterFailedRead()
    {
        // apple/goals.md 失敗表示: errorText holds only a change's sentence; a failed read neither writes nor clears it, only a read that works does.
        var phase = "list";
        var server = new Server { Respond = (request, _) => phase == "list" ? List(Snapshot(goal: Codex("active"))) : request.Method == HttpMethod.Post ? StubHandler.Json("{\"error\":\"X\"}", HttpStatusCode.BadRequest) : StubHandler.Json("{}", HttpStatusCode.InternalServerError) };
        var model = new GoalModel(server.Api());
        await model.LoadListAsync(); phase = "fail";
        await model.RunAsync(model.Snapshots[0], "pause"); var sentence = model.ErrorText; Assert.NotNull(sentence);
        await model.LoadListAsync();
        Assert.True(model.NeedsRefresh); Assert.Equal(sentence, model.ErrorText); Assert.Equal(sentence, GoalPillText.Failure(model, "bot-a"));
        phase = "list"; await model.LoadListAsync();
        Assert.Null(model.ErrorText); Assert.Null(GoalPillText.Failure(model, "bot-a"));
    }

    [Fact]
    public async Task APostSendsOneRequestWithTheMacBodyAndStoresTheAnswer()
    {
        var server = new Server();
        server.Respond = (request, _) => request.Method == HttpMethod.Get ? List(Snapshot(goal: Codex("active"))) : Changed("confirmed", Snapshot(goal: Codex("paused")));
        var model = new GoalModel(server.Api());
        await model.LoadListAsync();
        await model.ChangeAsync(model.Snapshots[0], "edit", "新しい目的", 8000);
        var post = server.Calls.Single(call => call.Method == HttpMethod.Post);
        Assert.Equal("/api/bots/bot-a/goal", post.Path);
        using var body = JsonDocument.Parse(post.Body);
        Assert.Equal(["action", "binding", "objective", "tokenBudget"], body.RootElement.EnumerateObject().Select(item => item.Name));
        Assert.Equal("edit", body.RootElement.GetProperty("action").GetString());
        Assert.Equal(8000, body.RootElement.GetProperty("tokenBudget").GetInt64());
        Assert.Equal("{\"sessionId\":\"s\",\"launchId\":\"l\",\"threadId\":\"t\"}", body.RootElement.GetProperty("binding").GetRawText());
        Assert.Equal("一時停止", model.Snapshots[0].StatusTitle); Assert.Null(model.ErrorText); Assert.False(model.NeedsRefresh);
        await model.ChangeAsync(model.Snapshots[0], "pause");
        using var plain = JsonDocument.Parse(server.Calls.Last(call => call.Method == HttpMethod.Post).Body);
        Assert.Equal(["action", "binding"], plain.RootElement.EnumerateObject().Select(item => item.Name)); // missing options are left out, not null
    }

    [Fact]
    public async Task AnUnconfirmedAnswerIsShownAsUnknownAndNotSuccess()
    {
        var server = new Server();
        server.Respond = (request, _) => request.Method == HttpMethod.Get ? List(Snapshot(goal: Codex("active"))) : Changed("unconfirmed", Snapshot(goal: Codex("active")), HttpStatusCode.Accepted);
        var model = new GoalModel(server.Api());
        await model.LoadListAsync();
        var error = await Assert.ThrowsAsync<GoalChangeException>(() => model.ChangeAsync(model.Snapshots[0], "clear"));
        Assert.Equal("変更結果を確認できませんでした。現在の状態を確認してから操作してください。", error.Message);
        Assert.True(model.NeedsRefresh); Assert.Empty(model.CurrentSnapshots);
        // Until a read succeeds, no further write is sent.
        await Assert.ThrowsAsync<GoalChangeException>(() => model.ChangeAsync(model.Snapshots[0], "clear"));
        Assert.Single(server.Calls, call => call.Method == HttpMethod.Post);
    }

    [Fact]
    public async Task ALostAnswerReadsTheStateBackOnceAndNeverResendsTheWrite()
    {
        var server = new Server();
        server.Respond = (request, _) => request.Method == HttpMethod.Post ? throw new HttpRequestException("reset") : request.RequestUri!.AbsolutePath == "/api/goals" ? List(Snapshot(goal: Codex("active"))) : Detail(Snapshot(goal: Codex("paused")));
        var model = new GoalModel(server.Api());
        await model.LoadListAsync();
        var error = await Assert.ThrowsAsync<GoalChangeException>(() => model.ChangeAsync(model.Snapshots[0], "pause"));
        Assert.Equal("変更の応答を確認できませんでした。現在取得できた状態を表示しています。操作前に確認してください。", error.Message);
        Assert.Single(server.Calls, call => call.Method == HttpMethod.Post);
        Assert.Equal(["GET", "POST", "GET"], server.Calls.Select(call => call.Method.Method));
        Assert.Equal("一時停止", model.Snapshots[0].StatusTitle); // the read-back, not the hoped-for result

        server.Calls.Clear();
        server.Respond = (request, _) => throw new HttpRequestException("down");
        var both = await Assert.ThrowsAsync<GoalChangeException>(() => model.ChangeAsync(model.Snapshots[0], "resume"));
        Assert.Equal("変更結果と現在の状態を確認できませんでした。更新して確認してください。", both.Message);
        Assert.True(model.NeedsRefresh);
        Assert.Equal(["POST", "GET"], server.Calls.Select(call => call.Method.Method));
    }

    [Fact]
    public async Task AServerRefusalLeadsToTheSameReadBack()
    {
        var server = new Server();
        server.Respond = (request, _) => request.Method == HttpMethod.Post ? StubHandler.Json("{\"error\":\"GOAL_REJECTED\",\"message\":\"このゴールの状態では操作できません。更新して確認してください。\"}", HttpStatusCode.Conflict) : request.RequestUri!.AbsolutePath == "/api/goals" ? List(Snapshot(goal: Codex("active"))) : Detail(Snapshot(goal: Codex("active")));
        var model = new GoalModel(server.Api());
        await model.LoadListAsync();
        await model.RunAsync(model.Snapshots[0], "resume");
        Assert.Equal("変更の応答を確認できませんでした。現在取得できた状態を表示しています。操作前に確認してください。", model.ErrorText);
        Assert.Single(server.Calls, call => call.Method == HttpMethod.Post);
    }

    [Fact]
    public async Task AChangedConversationOrARunningReadStopsBeforeAnyRequest()
    {
        var server = new Server { Respond = (_, _) => List(Snapshot(goal: Codex("active"))) };
        var model = new GoalModel(server.Api());
        await model.LoadListAsync();
        var stale = model.Snapshots[0] with { Binding = new("s", "l", "older") };
        var error = await Assert.ThrowsAsync<GoalChangeException>(() => model.ChangeAsync(stale, "pause"));
        Assert.Equal("会話が変わりました。現在のゴールを更新してから操作してください。", error.Message);
        var gate = new TaskCompletionSource();
        server.Respond = (_, _) => { gate.Task.Wait(); return List(Snapshot(goal: Codex("active"))); };
        var reading = Task.Run(() => model.LoadListAsync());
        while (!model.Loading) await Task.Delay(5);
        var busy = await Assert.ThrowsAsync<GoalChangeException>(() => model.ChangeAsync(model.Snapshots[0], "pause"));
        Assert.Equal("ゴールの更新が終わってから保存してください。", busy.Message);
        await model.LoadListAsync(); // a second read while one runs is skipped
        gate.SetResult(); await reading;
        Assert.DoesNotContain(server.Calls, call => call.Method == HttpMethod.Post);
        Assert.Equal(2, server.Calls.Count);
    }

    [Fact]
    public async Task PillTitleBeforeAndAfterAFailedFirstRead()
    {
        var server = new Server { Respond = (_, _) => StubHandler.Json("{}", HttpStatusCode.InternalServerError) };
        var model = new GoalModel(server.Api());
        Assert.Equal("ゴールを確認しています", GoalPill.Title(model, "bot-a"));
        await model.LoadDetailAsync("bot-a");
        Assert.Equal("ゴールの状態を確認できません", GoalPill.Title(model, "bot-a"));
    }

    [Fact]
    public async Task PillTitleFollowsTheSnapshot()
    {
        string snapshot = Snapshot(goal: null);
        var server = new Server { Respond = (_, _) => Detail(snapshot) };
        var model = new GoalModel(server.Api());
        await model.LoadDetailAsync("bot-a");
        Assert.Equal("ゴールは設定されていません", GoalPill.Title(model, "bot-a")); Assert.Null(model.CurrentSnapshot("bot-a")!.PillElapsed);
        snapshot = Snapshot(goal: Codex("active")); await model.LoadDetailAsync("bot-a");
        Assert.Equal("進行中", GoalPill.Title(model, "bot-a")); Assert.Equal("61.5秒", model.CurrentSnapshot("bot-a")!.PillElapsed);
        snapshot = Snapshot(availability: "unsupported"); await model.LoadDetailAsync("bot-a");
        Assert.Null(GoalPill.Title(model, "bot-a")); // no pill for a bot without the goal feature
        snapshot = Snapshot(availability: "unavailable"); await model.LoadDetailAsync("bot-a");
        Assert.Equal("ゴールの状態を確認できません", GoalPill.Title(model, "bot-a"));
        Assert.Equal("ゴールの状態を確認できません", GoalPill.Title(model, "someone-else")); // a snapshot of another Bot is not this Bot's
        snapshot = Snapshot(availability: "unavailable", extra: ",\"reason\":\"seat_idle\""); await model.LoadDetailAsync("bot-a");
        Assert.Equal("ゴールは設定されていません", GoalPill.Title(model, "bot-a")); Assert.Null(GoalPillText.Failure(model, "bot-a")); // an idle seat is not a failure
        snapshot = Snapshot(goal: Codex("complete")); await model.LoadDetailAsync("bot-a");
        Assert.Equal("完了", GoalPill.Title(model, "bot-a"));
    }

    [Theory]
    [InlineData("""{"type":"ready"}""", false, true)]
    [InlineData("""{"type":"goals","botId":"bot-a"}""", false, true)]
    [InlineData("""{"type":"queue"}""", false, true)]
    [InlineData("""{"type":"bots"}""", false, false)]
    [InlineData("""{"type":"updates"}""", false, false)]
    [InlineData("""{"type":"settings"}""", false, false)]
    [InlineData("""{"type":"setup"}""", false, false)]
    [InlineData("""{"type":"ai-control"}""", false, false)]
    [InlineData("""{"type":"messages"}""", false, true)]
    [InlineData("""{"type":"messages","all":true,"topics":["timeline"],"botIds":["b"],"roomIds":[]}""", false, true)]
    [InlineData("""{"type":"messages","all":false,"topics":["timeline"],"botIds":["b"],"roomIds":[]}""", false, false)]
    [InlineData("""{"type":"messages","all":false,"topics":["timeline"],"botIds":["b"],"roomIds":[]}""", true, true)]
    [InlineData("""{"type":"messages","all":false,"topics":["timeline"],"botIds":[],"roomIds":[]}""", false, true)]
    [InlineData("""{"type":"messages","all":false,"topics":["owner"],"botIds":[],"roomIds":[]}""", false, false)]
    [InlineData("""{"type":"messages","all":false,"topics":["nonsense"],"botIds":["b"],"roomIds":[]}""", false, true)]
    [InlineData("""{"type":"messages","all":false,"topics":["owner","owner"],"botIds":[],"roomIds":[]}""", false, true)]
    [InlineData("""{"type":7}""", false, true)]
    public void OnlyTheEventsTheMacCountsReloadTheGoals(string json, bool refreshFailing, bool reloads)
    {
        using var document = JsonDocument.Parse(json);
        Assert.Equal(reloads, GoalEvents.ShouldReload(document.RootElement, refreshFailing));
    }
}
