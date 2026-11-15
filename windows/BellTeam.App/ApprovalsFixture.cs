using System.IO;
using System.Net;
using System.Net.Http;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;

namespace BellTeam.App;

/// <summary>
/// Render seam for the 決裁箱 window (--render-approvals): an in-process server in the app contract shape (docs/architecture/modules/approval-box-extension/contract),
/// the roster and session of <see cref="LatticeFixture"/> behind it. Eight decisions: four to answer (モリー 急ぎ and linked, アドミ linked, a Claude Code decision from outside BellTeam with an image,
/// one from a member not on the roster), one held, three finished (delivered, delivery unknown, withdrawn). Scenes pick the state of the module:
/// not-connected, waiting, denied, expired-session, not-entitled, expired (contract), old (404), empty, reconnecting (503), unreadable summary, conflict (the first answer meets 409), unknown-delivery.
/// 答える answers 200 with the answered decision; 保留 flips it. Nothing is stored.
/// </summary>
internal sealed class ApprovalsFixture(string scene) : HttpMessageHandler
{
    private readonly HttpMessageInvoker roster = new(new LatticeFixture("list"));
    private readonly Dictionary<string, JsonObject> decisions = Build();
    private int summaryReads, answers;
    private static string Ago(double minutes) => DateTimeOffset.UtcNow.AddMinutes(-minutes).ToString("O");
    private static string Ahead(double minutes) => DateTimeOffset.UtcNow.AddMinutes(minutes).ToString("O");
    private static readonly byte[] Png = Convert.FromBase64String("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==");
    internal static string PngSha => Convert.ToHexString(SHA256.HashData(Png)).ToLowerInvariant();

    private static JsonObject Decision(string id, string title, string context, string status, string urgency, string[] options, int recommended, JsonNode origin, JsonNode? requester, JsonNode? link,
        double created, string? deadline = null, string? delivery = null, string? answer = null, string? cancelReason = null, bool amended = false, bool attachment = false)
    {
        var node = new JsonObject
        {
            ["id"] = id, ["title"] = title, ["context"] = context, ["urgency"] = urgency, ["deadline"] = deadline, ["status"] = status, ["delivery"] = delivery, ["resumePhrase"] = $"Approval Box {id} の答えを確認して続けて",
            ["version"] = amended ? 2 : 1, ["createdAt"] = Ago(created), ["updatedAt"] = Ago(created / 2), ["cancelReason"] = cancelReason,
            ["options"] = new JsonArray(options.Select((label, index) => (JsonNode)new JsonObject { ["id"] = $"o{index + 1}", ["label"] = label, ["recommended"] = index + 1 == recommended }).ToArray()),
            ["amended"] = new JsonObject { ["is"] = amended, ["fields"] = new JsonArray(amended ? [(JsonNode)"options"] : []), ["note"] = amended ? "選択肢を直しました" : null, ["at"] = amended ? Ago(created / 2) : null },
            ["history"] = new JsonArray([(JsonNode)new JsonObject { ["at"] = Ago(created), ["kind"] = "created", ["by"] = "ai" }, .. amended ? [(JsonNode)new JsonObject { ["at"] = Ago(created / 2), ["kind"] = "amended", ["by"] = "ai", ["fields"] = new JsonArray("options") }] : Array.Empty<JsonNode>(),
                .. status == "answered" ? [(JsonNode)new JsonObject { ["at"] = Ago(created / 3), ["kind"] = "answered", ["by"] = "user" }] : Array.Empty<JsonNode>()]),
            ["requestAttachments"] = new JsonArray(attachment ? [(JsonNode)new JsonObject { ["id"] = "A1", ["name"] = "receipt-list.png", ["contentType"] = "image/png", ["size"] = Png.Length, ["sha256"] = PngSha }] : []),
            ["origin"] = origin, ["requester"] = requester, ["link"] = link,
        };
        if (answer is not null) node["answer"] = new JsonObject { ["optionId"] = "o1", ["text"] = answer == "text" ? "もう少し調べてからやり直してください" : null, ["attachments"] = new JsonArray(), ["answeredAt"] = Ago(created / 3) };
        return node;
    }
    private static JsonObject Bell(string tool = "Claude Code", string session = "") => new() { ["kind"] = "bellteam", ["basis"] = "botId", ["client"] = "claude-code", ["tool"] = tool, ["sessionLabel"] = session, ["workLabel"] = session, ["connectionLabel"] = "bellteam", ["via"] = "connector" };
    private static JsonObject Outside(string client, string tool, string session, string via) => new() { ["kind"] = "external", ["basis"] = "none", ["client"] = client, ["tool"] = tool, ["sessionLabel"] = session, ["workLabel"] = session, ["connectionLabel"] = "mac", ["via"] = via };
    private static JsonObject Who(string id, string name) => new() { ["botId"] = id, ["name"] = name };
    private static JsonObject Link(string state, string chart, string task, string taskState, string[] previous, string[] next) => new()
    {
        ["state"] = state, ["attached"] = false, ["chart"] = new JsonObject { ["name"] = chart, ["projectId"] = "lattice" },
        ["task"] = new JsonObject { ["title"] = task, ["state"] = taskState, ["lane"] = "approval-box", ["cardId"] = "p1/t11" },
        ["previous"] = new JsonArray(previous.Select((title, index) => (JsonNode)new JsonObject { ["title"] = title, ["state"] = "done", ["cardId"] = $"p1/t0{index + 1}" }).ToArray()),
        ["next"] = new JsonArray(next.Select((title, index) => (JsonNode)new JsonObject { ["title"] = title, ["state"] = "pending", ["cardId"] = $"p1/t1{index + 2}" }).ToArray())
    };

    private static Dictionary<string, JsonObject> Build()
    {
        var all = new[]
        {
            Decision("K-1", "決裁箱拡張の月額を、決裁箱と同じ請求にしてよいですか？", "決裁箱は月額300円で課金しています。拡張を同じ請求に載せると、利用者は支払いを1か所で見られます。\n詳しい比較: https://example.com/billing-compare",
                "pending", "high", ["決裁箱と同じ請求にする", "別の請求にする（拡張だけ別に請求）"], 1, Bell("Claude Code", "モリー / billing"), Who("bot-molly", "モリー"), Link("linked", "BellTeam開発", "課金の設計", "ready", ["課金の方式を調べる"], ["課金の実装"]), 70, deadline: Ahead(150), amended: true),
            Decision("K-2", "席の自動更新を、夜間だけにしますか？", "更新が昼に走ると、席の会話が止まる時間ができます。", "pending", "normal", ["夜間だけにする", "今のままにする"], 0, Bell(), Who("bot-admi", "アドミ"), Link("linked", "BellTeam開発", "更新の時間帯を決める", "ready", [], ["配布手順の更新"]), 50),
            Decision("K-3", "領収書の保存先を、共有フォルダにしてよいですか？", "Macのレシート整理で、領収書のPDFを毎月まとめています。共有フォルダに移すと、経理の担当も同じ場所から読めます。", "pending", "normal", ["共有フォルダに保存する", "今のフォルダのままにする"], 0,
                Outside("claude-code", "Claude Code", "Macのレシート整理", "connector"), null, null, 35, attachment: true),
            Decision("K-4", "古い画面の片付けを進めますか？", "名簿にいないメンバーから届いた決裁です。", "pending", "normal", ["進める", "待つ"], 0, Bell(), Who("bot-ghost", "ゴースト"), null, 20),
            Decision("K-5", "通話の受け口の移し先を決めますか？", "移し先は2つあります。", "held", "normal", ["BellTeamの席へつなぐ", "別のホストを使う"], 0, Bell(), Who("bot-kiro", "キロ"), Link("linked", "BellTeam開発", "通話の受け口の移し", "ready", [], []), 300),
            Decision("K-6", "リリースノートの文面を確定しますか？", "今回の版の変更点をまとめました。", "answered", "normal", ["確定する", "直す"], 0, Bell(), Who("bot-molly", "モリー"), Link("answered", "BellTeam開発", "リリースノート", "done", [], ["配布"]), 180, delivery: "delivered", answer: "option"),
            Decision("K-7", "ブラウザ拡張の配布先を決めますか？", "Chrome ウェブストアか、自前の配布かを選びます。", "answered", "normal", ["ウェブストア", "自前の配布"], 0, Outside("chatgpt", "ChatGPT", "拡張の配布", "remote"), null, null, 1700, delivery: "unknown", answer: "option"),
            Decision("K-8", "古い案の実装を進めますか？", "別の案に切り替わったため、取り下げました。", "cancelled", "normal", ["進める", "やめる"], 0, Bell(), Who("bot-trony", "トロニー"), null, 2600, cancelReason: "別の案に切り替えました"),
        };
        return all.ToDictionary(item => item["id"]!.GetValue<string>());
    }
    private IEnumerable<JsonObject> Where(params string[] statuses) => decisions.Values.Where(item => statuses.Contains(item["status"]!.GetValue<string>())).OrderBy(item => item["status"]!.GetValue<string>() == "held" ? 1 : 0).ThenBy(item => item["urgency"]!.GetValue<string>() == "high" ? 0 : 1).ThenBy(item => item["createdAt"]!.GetValue<string>());
    private JsonObject Summary()
    {
        var pending = Where("pending").ToList();
        return new JsonObject { ["schema"] = "bellteam.approvals-summary.v1", ["pending"] = pending.Count, ["urgent"] = pending.Count(item => item["urgency"]!.GetValue<string>() == "high"), ["held"] = Where("held").Count(), ["answeredToday"] = 2, ["filedToday"] = 6,
            ["byOrigin"] = new JsonObject { ["bellteam"] = pending.Count(item => item["origin"]!["kind"]!.GetValue<string>() == "bellteam"), ["external"] = pending.Count(item => item["origin"]!["kind"]!.GetValue<string>() != "bellteam") } };
    }

    protected override Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken token)
    {
        var path = request.RequestUri!.AbsolutePath;
        if (!path.StartsWith("/api/approvals", StringComparison.Ordinal)) return roster.SendAsync(request, token);
        HttpResponseMessage Json(JsonNode value, HttpStatusCode status = HttpStatusCode.OK) => new(status) { Content = new StringContent(value.ToJsonString(), Encoding.UTF8, "application/json") };
        HttpResponseMessage Error(HttpStatusCode status, string code, string message, JsonObject? extra = null) { var error = new JsonObject { ["code"] = code, ["message"] = message }; if (extra is not null) foreach (var (key, value) in extra.ToList()) { extra.Remove(key); error[key] = value; } return Json(new JsonObject { ["error"] = error }, status); }
        HttpResponseMessage Failure() => scene switch
        {
            "old" => Json(new JsonObject { ["error"] = "NOT_FOUND" }, HttpStatusCode.NotFound),
            "not-entitled" => Error(HttpStatusCode.Forbidden, "not_entitled", "決裁箱の拡張は、まだ使えません。", new JsonObject { ["state"] = "none" }),
            "expired" => Error(HttpStatusCode.Forbidden, "not_entitled", "決裁箱の契約が切れています。", new JsonObject { ["state"] = "expired" }),
            "not-connected" or "waiting" or "denied" or "expired-session" => Error(HttpStatusCode.Conflict, "not_connected", "決裁箱につながっていません。", new JsonObject { ["state"] = scene == "expired-session" ? "expired" : "none" }),
            "reconnecting" => Error(HttpStatusCode.ServiceUnavailable, "unavailable", "いまは決裁箱を読めません。"), _ => null!
        };
        var blocked = Failure();
        if (path == "/api/approvals/connection") return Task.FromResult(Json(new JsonObject { ["state"] = scene switch { "waiting" => "waiting", "denied" => "denied", "expired-session" => "expired", "not-connected" => "not_connected", _ => "connected" } }));
        if (path == "/api/approvals/connect") return Task.FromResult(request.Method == HttpMethod.Post ? Json(new JsonObject { ["authorizationUrl"] = "https://approval.example/consent?code=abc", ["expiresAt"] = Ahead(10) }) : Json(new JsonObject { ["state"] = "not_connected" }));
        if (blocked is not null) return Task.FromResult(blocked);
        if (path == "/api/approvals/summary") return Task.FromResult(scene == "bad-summary" && summaryReads++ == 0 ? Json(new JsonObject { ["schema"] = "other" }) : Json(scene == "empty" ? new JsonObject { ["schema"] = "bellteam.approvals-summary.v1", ["pending"] = 0, ["urgent"] = 0, ["held"] = 0, ["answeredToday"] = 0, ["filedToday"] = 0, ["byOrigin"] = new JsonObject { ["bellteam"] = 0, ["external"] = 0 } } : Summary()));
        if (path == "/api/approvals/events") return Task.FromResult(new HttpResponseMessage(HttpStatusCode.OK) { Content = new StreamContent(new HeldStream()) { Headers = { ContentType = new("text/event-stream") } } });
        if (path == "/api/approvals")
        {
            var status = (request.RequestUri.Query.Split('=').ElementAtOrDefault(1) ?? "").Split('&')[0].Split(',', StringSplitOptions.RemoveEmptyEntries);
            return Task.FromResult(Json(new JsonObject { ["items"] = new JsonArray(scene == "empty" ? [] : Where(status).Select(item => (JsonNode)item.DeepClone()).ToArray()) }));
        }
        var parts = path["/api/approvals/".Length..].Split('/');
        if (parts is [var attachmentOwner, "attachments", _]) return Task.FromResult(new HttpResponseMessage(HttpStatusCode.OK) { Content = new ByteArrayContent(Png) { Headers = { ContentType = new("image/png") } } });
        if (!decisions.TryGetValue(parts[0], out var found)) return Task.FromResult(Error(HttpStatusCode.NotFound, "not_found", "この決裁は見つかりません。"));
        if (parts.Length == 1) return Task.FromResult(Json(found.DeepClone()));
        if (parts[1] is "hold" or "unhold") { found["status"] = parts[1] == "hold" ? "held" : "pending"; return Task.FromResult(Json(found.DeepClone())); }
        if (parts[1] == "answer")
        {
            if (scene == "conflict" && answers++ == 0)
            {
                var latest = (JsonObject)found.DeepClone(); latest["version"] = 3; latest["amended"] = new JsonObject { ["is"] = true, ["fields"] = new JsonArray("options"), ["note"] = "選択肢を直しました", ["at"] = Ago(1) };
                return Task.FromResult(Error(HttpStatusCode.Conflict, "conflict", "答える前に、内容が直されました。", new JsonObject { ["decision"] = latest }));
            }
            if (scene == "retry" && answers++ == 0) return Task.FromResult(Error(HttpStatusCode.ServiceUnavailable, "unavailable", "いまは決裁箱を読めません。"));
            found["status"] = "answered"; found["delivery"] = scene == "unknown-delivery" ? "unknown" : "delivered"; found["version"] = found["version"]!.GetValue<int>() + 1;
            found["answer"] = new JsonObject { ["optionId"] = "o1", ["text"] = null, ["attachments"] = new JsonArray(), ["answeredAt"] = Ago(0) };
            return Task.FromResult(Json(found.DeepClone()));
        }
        return Task.FromResult(Json(new JsonObject { ["error"] = "NOT_FOUND" }, HttpStatusCode.NotFound));
    }

    // The stream stays open and silent (a real one sends a heartbeat every 25 s).
    private sealed class HeldStream : Stream
    {
        public override async Task<int> ReadAsync(byte[] buffer, int offset, int count, CancellationToken token) { await Task.Delay(Timeout.Infinite, token); return 0; }
        public override async ValueTask<int> ReadAsync(Memory<byte> buffer, CancellationToken token = default) { await Task.Delay(Timeout.Infinite, token); return 0; }
        public override int Read(byte[] buffer, int offset, int count) => throw new NotSupportedException();
        public override bool CanRead => true; public override bool CanSeek => false; public override bool CanWrite => false; public override long Length => throw new NotSupportedException();
        public override long Position { get => throw new NotSupportedException(); set => throw new NotSupportedException(); }
        public override void Flush() { }
        public override long Seek(long offset, SeekOrigin origin) => throw new NotSupportedException();
        public override void SetLength(long value) => throw new NotSupportedException();
        public override void Write(byte[] buffer, int offset, int count) => throw new NotSupportedException();
    }
}
