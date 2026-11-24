using System.Net;
using System.Net.Http;
using System.Text;
using System.Text.Json;

namespace BellTeam.Linux;

/// <summary>
/// Render and test seam for the 決裁箱 window: an in-process BellTeam server for the only things the window still asks it since the /v1 close (the list is the device's book): the boot routes, the id-level chart
/// link (GET /api/approvals/by-decision: D-1 is linked, D-3 answered, everything else 404) and the 工程表との連携 connection (GET and DELETE /api/approvals/connection, POST and DELETE /api/approvals/connect).
/// Scenes: "main" (not connected), "connected", "waiting", "gone" (every /api/approvals route answers 404: a removed route must show no failure).
/// </summary>
internal sealed class ApprovalsFixture(string scene = "main", string seat = "none") : HttpMessageHandler
{
    private static readonly (string Id, string Name, string Color)[] Members = [("bot-trony", "トロニー", "indigo"), ("bot-flora", "フローラ", "violet"), ("bot-molly", "モリー", "mint")];
    private string connection = scene == "connected" ? "connected" : scene == "waiting" ? "waiting" : "not_connected";
    /// <summary>How many times by-decision was asked (the tests count it).</summary>
    internal int LinkReads { get; private set; }

    protected override Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken token)
    {
        var path = request.RequestUri!.AbsolutePath; var query = request.RequestUri.Query;
        HttpResponseMessage Json(object value, HttpStatusCode status = HttpStatusCode.OK) => new(status) { Content = new StringContent(JsonSerializer.Serialize(value), Encoding.UTF8, "application/json") };
        HttpResponseMessage NotFound() => Json(new { error = "NOT_FOUND" }, HttpStatusCode.NotFound);
        if (scene == "gone" && path.StartsWith("/api/approvals", StringComparison.Ordinal)) return System.Threading.Tasks.Task.FromResult(NotFound());
        var response = path switch
        {
            "/api/session" => Json(new { authenticated = true, authMode = "local" }),
            "/api/setup" => Json(new { phase = "ready", complete = true }),
            "/api/bots" => Json(new { bots = Members.Select(member => new { id = member.Id, name = member.Name, displayName = member.Name, color = member.Color }) }),
            "/api/rooms" => Json(new { rooms = Array.Empty<object>() }), "/api/queue" => Json(new { items = Array.Empty<object>() }),
            "/api/owner" => Json(new { owner = new { name = "利用者" } }), "/api/settings" => Json(new { settings = Array.Empty<object>() }),
            "/api/approvals/by-decision" => ByDecision(query),
            "/api/approvals/connection" when request.Method == HttpMethod.Delete => Disconnect(),
            "/api/approvals/connection" => Json(new { state = connection }),
            "/api/approvals/connect" when request.Method == HttpMethod.Delete => Json(new { state = connection }),
            "/api/approvals/connect" => Connect(),
            "/api/approvals/seat-link" or "/api/approvals/seat-link/start" or "/api/approvals/seat-link/stop" => SeatLink(path),
            _ => NotFound()
        };
        return System.Threading.Tasks.Task.FromResult(response);

        HttpResponseMessage ByDecision(string q)
        {
            LinkReads++;
            return Uri.UnescapeDataString(q.TrimStart('?').Replace("id=", "")) switch
            {
                "D-1" => Json(new { project = "lattice", plan = "p1", task = "t07", state = "linked", attached = true }),
                "D-3" => Json(new { project = "lattice", plan = "p1", task = "t09", state = "answered", attached = true }),
                _ => NotFound()
            };
        }
        // The body's three seat-link routes (seat-approval-card.md): scene state, start waits for the scan, stop ends it.
        HttpResponseMessage SeatLink(string route)
        {
            if (route.EndsWith("/start", StringComparison.Ordinal)) seat = "waiting"; else if (route.EndsWith("/stop", StringComparison.Ordinal)) seat = "none";
            return seat == "waiting"
                ? Json(new { state = "waiting", code = "4CH9-MGVR-13NC-MC6C", qrText = "https://approval-box.example/pair?c=4CH9MGVR13NCMC6C", expiresAt = DateTimeOffset.UtcNow.AddMinutes(4).AddSeconds(30).ToString("O") })
                : seat is "failed-rejected" or "failed-expired" ? Json(new { state = "failed", reason = seat[7..] }) : Json(new { state = seat });
        }
        HttpResponseMessage Disconnect() { connection = "not_connected"; return Json(new { state = connection }); }
        HttpResponseMessage Connect() { connection = "waiting"; return Json(new { authorizationUrl = "https://approval.example/consent?code=fixture", expiresAt = DateTimeOffset.UtcNow.AddMinutes(10).ToString("O") }); }
    }
}
