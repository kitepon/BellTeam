using System.IO;
using System.Net;
using System.Net.Http;
using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;

namespace BellTeam.Linux;

/// <summary>
/// Render seam for the 決裁箱 window (--render-approvals): an in-process server in the app contract shape of /api/approvals/* (docs/architecture/modules/approval-box-extension/contract),
/// with decisions of every kind the screen draws: a BellTeam member's with a chart link (急ぎ, amended), one without a link, an external one (Claude Code, with an attachment), one of unknown origin,
/// a held one, and answered / withdrawn ones in 済み. Times are relative to now. Scenes pick the failure view (not-connected, not-entitled, expired, old) or the empty list.
/// </summary>
internal sealed class ApprovalsFixture(string scene) : HttpMessageHandler
{
    private static readonly (string Id, string Name, string Color)[] Members = [("bot-trony", "トロニー", "indigo"), ("bot-flora", "フローラ", "violet"), ("bot-molly", "モリー", "mint")];
    // A 2 x 2 PNG: the thumbnail is drawn from real bytes (size and sha256 of the fixture body are not checked: size 0 / no sha in the scene's attachment).
    private static readonly byte[] Png = Convert.FromBase64String("iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAYAAABytg0kAAAAFklEQVR4nGP8z8Dwn4EIwESMolGFFAEARpUCCDcw1ZkAAAAASUVORK5CYII=");
    private static string Ago(double minutes) => DateTimeOffset.UtcNow.AddMinutes(-minutes).ToString("O");
    private static string In(double minutes) => DateTimeOffset.UtcNow.AddMinutes(minutes).ToString("O");

    private static object Origin(string kind, string client, string tool, string session, string via) => new { kind, basis = kind == "bellteam" ? "botId" : "none", client, tool, sessionLabel = session, workLabel = session, connectionLabel = "fixture", via };
    private static object Task(string title, string state, string card) => new { title, state, cardId = card };
    private static object Decision(string id, string title, string context, string status, object origin, object? requester, object? link, double created, string urgency = "normal", double? deadline = null,
        bool amended = false, object[]? answer = null, string? delivery = null, string? cancel = null, double? updated = null, object[]? attachments = null, string[]? options = null)
        => new
        {
            id, title, context, options = (options ?? ["決裁箱と同じ請求にする", "別の請求にする"]).Select((label, index) => new { id = $"o{index + 1}", label, recommended = index == 0 && status == "pending" && id == "K-1" }), urgency, deadline = deadline is { } at ? In(at) : null, status,
            answer = answer is null ? null : new { optionId = "o1", text = (string?)null, attachments = Array.Empty<object>(), answeredAt = Ago(updated ?? 30) }, delivery, resumePhrase = $"Approval Box {id} の答えを確認して続けて", version = amended ? 2 : 1,
            createdAt = Ago(created), updatedAt = Ago(updated ?? created), cancelReason = cancel, amended = new { @is = amended, fields = amended ? new[] { "options" } : [], note = amended ? "選択肢を直しました" : null, at = amended ? Ago(created - 10) : null },
            history = new object[] { new { at = Ago(created), kind = "created", by = "ai" } }.Concat(amended ? [new { at = Ago(created - 10), kind = "amended", by = "ai", fields = new[] { "options" } }] : []).ToArray(),
            requestAttachments = attachments ?? [], origin, requester, link
        };

    private object[] All()
    {
        var link = new { state = "linked", attached = true, chart = new { name = "Lattice組込", projectId = "lattice" }, task = new { title = "公開契約の裁定", state = "ready", lane = "approval-box", cardId = "p1/t07" },
            previous = new[] { Task("部品の配置と保存場所", "in-progress", "p1/t04") }, next = new[] { Task("部品の実装", "pending", "p1/t08") } };
        var bell = Origin("bellteam", "claude-code", "Claude Code", "トロニー / 公開契約", "connector");
        return
        [
            Decision("K-1", "公開契約の裁定を、今日中に確定してよいですか？", "部品の実装が契約の確定を待っています。確定すると、フローラが実装に進めます。\n詳しい経緯: https://example.com/contract-notes", "pending", bell, new { botId = "bot-trony", name = "トロニー" }, link, 95, "high", 420, amended: true),
            Decision("K-2", "夜間の控えの保存先を、共有ディスクへ移してよいですか？", "今の保存先は残り容量が少なくなっています。移すと、控えの保存が止まる時間は約1分です。", "pending", Origin("bellteam", "codex", "Codex", "モリー / 夜間の整備", "connector"), new { botId = "bot-molly", name = "モリー" }, null, 48, options: ["共有ディスクへ移す", "今のままにする"]),
            Decision("K-3", "領収書の保存先を、共有フォルダにしてよいですか？", "Macのレシート整理で、領収書のPDFを毎月まとめています。共有フォルダに移すと、経理の担当も同じ場所から読めます。", "pending", Origin("external", "claude-code", "Claude Code", "Macのレシート整理", "remote"), null, null, 31,
                attachments: [new { id = "A-1", name = "receipt-list.png", contentType = "image/png", size = 0, sha256 = "" }], options: ["共有フォルダに保存する", "今のフォルダのままにする"]),
            Decision("K-4", "このスクリプトを、毎晩実行してよいですか？", "実行すると約5分かかります。", "pending", Origin("unknown", "other", "出どころ不明", "", ""), null, null, 12, options: ["毎晩実行する", "実行しない"]),
            Decision("K-5", "旧い版のAPIを、今月で終わらせてよいですか？", "終わらせる前に、利用者への案内が要ります。", "held", bell, new { botId = "bot-flora", name = "フローラ" }, null, 300, updated: 60),
            Decision("K-6", "更新の通知を、夜間にまとめて送ってよいですか？", "毎時の通知が多すぎるという声がありました。", "answered", bell, new { botId = "bot-molly", name = "モリー" }, null, 200, answer: [new { }], delivery: "delivered", updated: 25),
            Decision("K-7", "請求書の名前を、日付つきに変えてよいですか？", "PDFの名前が重なる問題があります。", "answered", Origin("external", "chatgpt", "ChatGPT", "請求書の整理", "remote"), null, null, 1700, answer: [new { }], delivery: "unknown", updated: 1500),
            Decision("K-8", "古いログを消してよいですか？", "別の方法で足りることが分かりました。", "cancelled", bell, new { botId = "bot-trony", name = "トロニー" }, null, 3000, cancel: "別の方法に決まりました", updated: 2900),
        ];
    }

    protected override Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken token)
    {
        var path = request.RequestUri!.AbsolutePath; var query = request.RequestUri.Query;
        HttpResponseMessage Json(object value, HttpStatusCode status = HttpStatusCode.OK) => new(status) { Content = new StringContent(value is JsonNode node ? node.ToJsonString() : JsonSerializer.Serialize(value), Encoding.UTF8, "application/json") };
        HttpResponseMessage Failure(HttpStatusCode status, string code, string? state = null) => Json(new { error = new { code, message = "", state } }, status);
        if (path.StartsWith("/api/approvals", StringComparison.Ordinal))
        {
            if (scene == "old") return System.Threading.Tasks.Task.FromResult(Json(new { error = "NOT_FOUND" }, HttpStatusCode.NotFound));
            if (scene == "not-entitled") return System.Threading.Tasks.Task.FromResult(Failure(HttpStatusCode.Forbidden, "not_entitled", "none"));
            if (scene == "expired") return System.Threading.Tasks.Task.FromResult(Failure(HttpStatusCode.Forbidden, "not_entitled", "expired"));
            if (scene is "not-connected" or "waiting" && path != "/api/approvals/connect" && path != "/api/approvals/connection") return System.Threading.Tasks.Task.FromResult(Failure(HttpStatusCode.Conflict, "not_connected"));
        }
        var all = scene == "empty" ? [] : All();
        var response = path switch
        {
            "/api/session" => Json(new { authenticated = true, authMode = "local" }),
            "/api/setup" => Json(new { phase = "ready", complete = true }),
            "/api/bots" => Json(new { bots = Members.Select(member => new { id = member.Id, name = member.Name, displayName = member.Name, color = member.Color }) }),
            "/api/rooms" => Json(new { rooms = Array.Empty<object>() }), "/api/queue" => Json(new { items = Array.Empty<object>() }),
            "/api/owner" => Json(new { owner = new { name = "利用者" } }), "/api/settings" => Json(new { settings = Array.Empty<object>() }),
            "/api/approvals/summary" => Json(new { schema = "bellteam.approvals-summary.v1", pending = all.Length == 0 ? 0 : 4, urgent = all.Length == 0 ? 0 : 1, held = all.Length == 0 ? 0 : 1, answeredToday = all.Length == 0 ? 0 : 2, filedToday = all.Length == 0 ? 0 : 6, byOrigin = new { bellteam = all.Length == 0 ? 0 : 2, external = all.Length == 0 ? 0 : 2 } }),
            "/api/approvals" => Json(new { items = List(all, query) }),
            "/api/approvals/events" => new HttpResponseMessage(HttpStatusCode.OK) { Content = new StreamContent(new OpenStream()) { Headers = { ContentType = new("text/event-stream") } } },
            "/api/approvals/connection" => Json(new { state = scene == "waiting" ? "waiting" : "not_connected" }),
            "/api/approvals/connect" => Json(new { authorizationUrl = "https://approval.example/consent?code=fixture", expiresAt = In(10) }),
            _ when path.EndsWith("/answer", StringComparison.Ordinal) && request.Method == HttpMethod.Post && Find(all, path["/api/approvals/".Length..^"/answer".Length]) is { } target => Json(Answered(target)),
            _ when path.StartsWith("/api/approvals/", StringComparison.Ordinal) && all.FirstOrDefault(item => JsonSerializer.SerializeToElement(item).GetProperty("id").GetString() == Uri.UnescapeDataString(path["/api/approvals/".Length..])) is { } found => Json(found),
            _ when path.Contains("/attachments/", StringComparison.Ordinal) => new HttpResponseMessage(HttpStatusCode.OK) { Content = new ByteArrayContent(Png) { Headers = { ContentType = new("image/png") } } },
            _ when path.EndsWith("/messages", StringComparison.Ordinal) => Json(new { items = Array.Empty<object>(), hasMore = false }),
            _ => Json(new { error = "NOT_FOUND" }, HttpStatusCode.NotFound)
        };
        return System.Threading.Tasks.Task.FromResult(response);
    }
    private static object? Find(object[] all, string id) => all.FirstOrDefault(item => JsonSerializer.SerializeToElement(item).GetProperty("id").GetString() == Uri.UnescapeDataString(id));
    // The answer is accepted: the same decision, answered and delivered (delivery states other than "delivered" are covered by the Core tests).
    private static JsonNode Answered(object decision)
    {
        var node = JsonSerializer.SerializeToNode(decision)!.AsObject();
        node["status"] = "answered"; node["delivery"] = "delivered"; node["version"] = 3;
        node["answer"] = new JsonObject { ["optionId"] = "o1", ["text"] = null, ["attachments"] = new JsonArray(), ["answeredAt"] = DateTimeOffset.UtcNow.ToString("O") };
        return node;
    }
    private static object[] List(object[] all, string query)
    {
        var done = query.Contains("answered", StringComparison.Ordinal);
        return all.Where(item => JsonSerializer.SerializeToElement(item).GetProperty("status").GetString() is { } status && (done ? status is "answered" or "cancelled" : status is "pending" or "held")).ToArray();
    }
    // The stream stays open and silent (a real one sends a heartbeat every 25 s).
    private sealed class OpenStream : Stream
    {
        public override bool CanRead => true; public override bool CanSeek => false; public override bool CanWrite => false; public override long Length => throw new NotSupportedException();
        public override long Position { get => throw new NotSupportedException(); set => throw new NotSupportedException(); }
        public override void Flush() { }
        public override int Read(byte[] buffer, int offset, int count) { Thread.Sleep(Timeout.Infinite); return 0; }
        public override async ValueTask<int> ReadAsync(Memory<byte> buffer, CancellationToken token = default) { await System.Threading.Tasks.Task.Delay(Timeout.Infinite, token); return 0; }
        public override long Seek(long offset, SeekOrigin origin) => throw new NotSupportedException();
        public override void SetLength(long value) => throw new NotSupportedException();
        public override void Write(byte[] buffer, int offset, int count) => throw new NotSupportedException();
    }
}
