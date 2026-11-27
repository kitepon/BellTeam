using System.Net;
using System.Net.Http;
using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;

namespace BellTeam.App;

/// <summary>
/// Render and test seam for the 決裁箱 window (--render-approvals): an in-process BellTeam server for the only things the window still asks it since the /v1 close (the list is the device's book): the roster and session of
/// <see cref="LatticeFixture"/>, the id-level chart link (GET /api/approvals/by-decision: K-1 is linked, K-6 answered, everything else 404) and the 工程表との連携 connection (GET and DELETE /api/approvals/connection, POST and DELETE /api/approvals/connect).
/// Scenes of the module: "main" (not connected), "connected", "waiting", "denied", "gone" (every /api/approvals route answers 404: a removed route must show no failure screen), "unreadable" (503 on all of them).
/// <see cref="Demo"/> is the stand-in device session with the decisions the scenes draw. Nothing is stored.
/// </summary>
internal sealed class ApprovalsFixture(string scene) : HttpMessageHandler
{
    private readonly HttpMessageInvoker roster = new(new LatticeFixture("list"));
    private string connection = scene switch { "connected" => "connected", "waiting" => "waiting", "denied" => "denied", _ => "not_connected" };
    /// <summary>How many times by-decision was asked (the tests count it).</summary>
    internal int LinkReads { get; private set; }
    /// <summary>The seat-link (「決裁箱につなぐ」) answer of the stand-in body: GET reads it, start sets <see cref="SeatLinkOnStart"/>, stop sets none.</summary>
    internal JsonObject SeatLink { get; set; } = new() { ["state"] = "none" };
    internal JsonObject SeatLinkOnStart { get; set; } = new() { ["state"] = "waiting", ["code"] = "WXYZ-1234", ["typedSecret"] = "QRST5678ABCD1234", ["qrText"] = "https://approval-box.example/pair?c=WXYZ-1234&s=QRST5678ABCD1234", ["expiresAt"] = DateTimeOffset.UtcNow.AddMinutes(5).ToString("O") };
    /// <summary>What the page sent to the connection routes (method and path), for the tests.</summary>
    internal List<(string Method, string Path)> Sent { get; } = [];

    protected override Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken token)
    {
        var path = request.RequestUri!.AbsolutePath; var query = request.RequestUri.Query;
        if (!path.StartsWith("/api/approvals", StringComparison.Ordinal)) return roster.SendAsync(request, token);
        lock (Sent) Sent.Add((request.Method.Method, path));
        HttpResponseMessage Json(JsonNode value, HttpStatusCode status = HttpStatusCode.OK) => new(status) { Content = new StringContent(value.ToJsonString(), Encoding.UTF8, "application/json") };
        HttpResponseMessage NotFound() => Json(new JsonObject { ["error"] = "NOT_FOUND" }, HttpStatusCode.NotFound);
        if (scene == "gone") return Task.FromResult(NotFound());
        if (scene == "unreadable") return Task.FromResult(Json(new JsonObject { ["error"] = new JsonObject { ["code"] = "unavailable", ["message"] = "いまは読めません。" } }, HttpStatusCode.ServiceUnavailable));
        var response = path switch
        {
            "/api/approvals/by-decision" => ByDecision(query),
            "/api/approvals/seat-link" => Json(SeatLink),
            "/api/approvals/seat-link/start" => Json(SeatLink = SeatLinkOnStart),
            "/api/approvals/seat-link/stop" => Json(SeatLink = new JsonObject { ["state"] = "none" }),
            "/api/approvals/connection" when request.Method == HttpMethod.Delete => Disconnect(),
            "/api/approvals/connection" => Json(new JsonObject { ["state"] = connection }),
            "/api/approvals/connect" when request.Method == HttpMethod.Delete => Disconnect(),
            "/api/approvals/connect" => Connect(),
            _ => NotFound()
        };
        return Task.FromResult(response);

        HttpResponseMessage ByDecision(string q)
        {
            LinkReads++;
            return Uri.UnescapeDataString(q.TrimStart('?').Replace("id=", "")) switch
            {
                "K-1" => Json(new JsonObject { ["project"] = "lattice", ["plan"] = "p1", ["task"] = "t07", ["state"] = "linked", ["attached"] = true }),
                "K-6" => Json(new JsonObject { ["project"] = "lattice", ["plan"] = "p1", ["task"] = "t09", ["state"] = "answered", ["attached"] = true }),
                _ => NotFound()
            };
        }
        HttpResponseMessage Disconnect() { connection = "not_connected"; return Json(new JsonObject { ["state"] = connection }); }
        HttpResponseMessage Connect() { connection = "waiting"; return Json(new JsonObject { ["authorizationUrl"] = "https://approval.example/consent?code=abc", ["expiresAt"] = DateTimeOffset.UtcNow.AddMinutes(10).ToString("O") }); }
    }

    /// <summary>The stand-in child join (the component's joinState and calls): a test or a render scene sets the state and calls Raise; the calls are recorded, nothing is stored.</summary>
    internal sealed class Join : IChildJoin
    {
        public ChildJoinPhase Phase { get; set; } = ChildJoinPhase.NotJoined;
        public bool SigningIn { get; set; }
        public string? QrLink { get; set; }
        public DateTimeOffset? ExpiresAt { get; set; }
        public string? FailedCode { get; set; }
        public string? Code { get; set; }
        public string? Words { get; set; }
        public bool Removed { get; set; }
        public bool UpdateRequired { get; set; }
        public event Action? Changed;
        public List<string?> Joins { get; } = [];
        public int Cancels, Leaves;
        public void Raise() => Changed?.Invoke();
        public Task JoinAsync(string? provider) { Joins.Add(provider); SigningIn = provider is not null && Phase != ChildJoinPhase.Failed; Raise(); return Task.CompletedTask; }
        public void CancelJoin() { Cancels++; SigningIn = false; Phase = ChildJoinPhase.NotJoined; Raise(); }
        public Task LeaveAsync() { Leaves++; Phase = ChildJoinPhase.NotJoined; Removed = false; Raise(); return Task.CompletedTask; }
    }

    /// <summary>The stand-in source: a list the scene fills (K-1 to K-5 open, K-6 answered, K-7 withdrawn) and an answer sink that closes the decision like the server's answer.</summary>
    internal sealed class Demo : IApprovalSource
    {
        private readonly List<ViewDecision> list = [];
        public IReadOnlyList<ViewDecision> Decisions => [.. list];
        public void Start() { }
        public RuntimeState State { get; set; } = new(RuntimeStatus.Live);
        public event Action? Changed;
        public List<(string Id, string? Option, string? Text)> Answers { get; } = [];
        public List<(string Id, bool Held)> Holds { get; } = [];
        public int Refreshed;
        /// <summary>What the next answer is acknowledged with ("ok" closes the decision; anything else leaves it open).</summary>
        public string Ack { get; set; } = "ok";
        public void Raise() => Changed?.Invoke();
        private void Set(string id, Func<ViewDecision, ViewDecision> change) { var at = list.FindIndex(d => d.Id == id); list[at] = change(list[at]); }
        public Task<SendOutcome> AnswerAsync(string decisionId, string? optionId, string? text, long version)
        {
            Answers.Add((decisionId, optionId, text));
            if (Ack != "ok") return Task.FromResult(new SendOutcome(Ack));
            Set(decisionId, d => d with { Status = "answered", Answer = new ApprovalAnswer { OptionId = optionId, Text = text, AnsweredAt = DateTimeOffset.UtcNow.ToString("O") }, Delivery = "waiting" }); Changed?.Invoke();
            return Task.FromResult(new SendOutcome("ok"));
        }
        public Task<SendOutcome> HoldAsync(string decisionId, bool held)
        {
            Holds.Add((decisionId, held)); Set(decisionId, d => d with { Status = held ? "held" : "pending" }); Changed?.Invoke();
            return Task.FromResult(new SendOutcome("ok"));
        }
        public void Refresh() => Refreshed++;
        public Task<byte[]?> AttachmentAsync(string decisionId, string attachmentId) => Task.FromResult<byte[]?>(null);

        /// <summary>One request as the source holds it. requesterBotId null = a decision from outside BellTeam.</summary>
        public void Add(string id, string title, string context, string[] options, int recommended = 0, bool urgent = false, double deadlineMinutes = 0, string? requester = null, string? requesterBotId = null, string client = "claude-code", double ageMinutes = 30)
        {
            var created = DateTimeOffset.UtcNow.AddMinutes(-ageMinutes).ToString("yyyy-MM-ddTHH:mm:ssZ");
            list.Add(new ViewDecision
            {
                Id = id, Title = title, Context = context, Urgency = urgent ? "high" : "normal", Deadline = deadlineMinutes > 0 ? DateTimeOffset.UtcNow.AddMinutes(deadlineMinutes).ToString("O") : null,
                Status = "pending", Version = 1, CreatedAt = created, UpdatedAt = created,
                Options = options.Select((label, index) => new ApprovalOption { Id = $"o{index + 1}", Label = label, Recommended = recommended == index + 1 }).ToArray(),
                Origin = new ApprovalOrigin { Client = client, Tool = ApprovalsV1.ToolOf(client), SessionLabel = requester is null ? "Macのレシート整理" : "端末で受信", WorkLabel = "確認", Via = "connector" },
                Requester = requester is null && requesterBotId is null ? null : new ApprovalRequester { BotId = requesterBotId, Name = requester },
            });
        }
        /// <summary>The decisions of the scenes.</summary>
        public Demo Fill()
        {
            Add("K-1", "決裁箱拡張の月額を、決裁箱と同じ請求にしてよいですか？", "決裁箱は月額300円で課金しています。拡張を同じ請求に載せると、利用者は支払いを1か所で見られます。\n詳しい比較: https://example.com/billing-compare", ["決裁箱と同じ請求にする", "別の請求にする（拡張だけ別に請求）"], 1, true, 150, "モリー", "bot-molly", ageMinutes: 70);
            Add("K-2", "席の自動更新を、夜間だけにしますか？", "更新が昼に走ると、席の会話が止まる時間ができます。", ["夜間だけにする", "今のままにする"], 0, false, 0, "アドミ", "bot-admi", ageMinutes: 50);
            Add("K-3", "領収書の保存先を、共有フォルダにしてよいですか？", "Macのレシート整理で、領収書のPDFを毎月まとめています。共有フォルダに移すと、経理の担当も同じ場所から読めます。", ["共有フォルダに保存する", "今のフォルダのままにする"], ageMinutes: 35);
            Add("K-4", "古い画面の片付けを進めますか？", "名簿にいないメンバーから届いた決裁です。", ["進める", "待つ"], 0, false, 0, "ゴースト", "bot-ghost", ageMinutes: 20);
            Add("K-5", "通話の受け口の移し先を決めますか？", "移し先は2つあります。", ["BellTeamの席へつなぐ", "別のホストを使う"], 0, false, 0, "キロ", "bot-kiro", ageMinutes: 300);
            Set("K-5", d => d with { Status = "held" });
            Add("K-6", "リリースノートの文面を確定しますか？", "今回の版の変更点をまとめました。", ["確定する", "直す"], 0, false, 0, "モリー", "bot-molly", ageMinutes: 180);
            Set("K-6", d => d with { Status = "answered", Answer = new ApprovalAnswer { OptionId = "o1", AnsweredAt = DateTimeOffset.UtcNow.AddMinutes(-60).ToString("O") }, Delivery = "waiting", UpdatedAt = DateTimeOffset.UtcNow.AddMinutes(-60).ToString("yyyy-MM-ddTHH:mm:ssZ") });
            Add("K-7", "古い案の実装を進めますか？", "別の案に切り替わったため、取り下げました。", ["進める", "やめる"], 0, false, 0, "トロニー", "bot-trony", ageMinutes: 2600);
            Set("K-7", d => d with { Status = "cancelled", CancelReason = "closed", UpdatedAt = DateTimeOffset.UtcNow.AddMinutes(-2500).ToString("yyyy-MM-ddTHH:mm:ssZ") });
            return this;
        }
    }
}
