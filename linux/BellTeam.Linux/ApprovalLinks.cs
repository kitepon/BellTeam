using System.Net;
using System.Text.Json;
using BellTeam.Core;

namespace BellTeam.Linux;

/// <summary>
/// The link of a decision to a chart task, read from BellTeam's id-level lookup (GET /api/approvals/by-decision?id=; ids and state only, read from the link record, no Approval Box call; Delta,
/// peer-channel-feed.md section 5). The device's book is the list; this only adds the badge and the 工程とのつながり panel. 404 = not linked; any other failure draws no badge and asks again later.
/// </summary>
internal sealed class ApprovalLinks
{
    private static readonly TimeSpan Fresh = TimeSpan.FromSeconds(60), NotLinkedFresh = TimeSpan.FromSeconds(30);   // a 404 is asked again after 30 s (the engine may not have caught up yet)   // the link engine catches up every 5 minutes; a minute keeps the badge honest without a read per repaint
    private readonly Dictionary<string, (ApprovalLink? Link, DateTimeOffset At)> byId = [];
    private readonly HashSet<string> reading = [];

    internal ApprovalLink? Of(string? id) => id is not null && byId.TryGetValue(id, out var known) ? known.Link : null;
    internal ViewDecision Join(ViewDecision decision) => Of(decision.Id) is { } link ? decision with { Link = link } : decision.Id is { } id && byId.ContainsKey(id) ? decision with { NotLinked = true } : decision;
    internal bool AnyNotLinked => byId.Values.Any(known => known.Link is null);
    internal void Forget() { byId.Clear(); reading.Clear(); }

    internal static ApprovalLink? Parse(JsonElement body)
    {
        if (body.ValueKind != JsonValueKind.Object || !body.TryGetProperty("project", out var project) || !body.TryGetProperty("plan", out var plan) || !body.TryGetProperty("task", out var task)) return null;
        if (project.GetString() is not { Length: > 0 } projectId || plan.GetString() is not { Length: > 0 } planKey || task.GetString() is not { Length: > 0 } taskId) return null;
        var state = body.TryGetProperty("state", out var s) ? s.GetString() : null; var attached = body.TryGetProperty("attached", out var a) && a.ValueKind == JsonValueKind.True;
        return new ApprovalLink { State = state, Attached = attached, Chart = new ApprovalChart { ProjectId = projectId }, Task = new ApprovalTask { CardId = $"{planKey}/{taskId}" } };
    }

    /// <summary>Reads the lookup for every listed decision that is unknown or older than a minute; <paramref name="changed"/> runs after a read that changed an answer. Never throws for a failed read.</summary>
    internal async Task ReadAsync(BellApi api, IEnumerable<ViewDecision> decisions, Action changed, CancellationToken token)
    {
        foreach (var decision in decisions.ToList())
        {
            if (decision.Id is not { Length: > 0 } id || (byId.TryGetValue(id, out var known) && DateTimeOffset.UtcNow - known.At < (known.Link is null ? NotLinkedFresh : Fresh)) || !reading.Add(id)) continue;
            try
            {
                var link = Parse(await api.GetAsync<JsonElement>($"/api/approvals/by-decision?id={Uri.EscapeDataString(id)}", token));
                var before = Of(id); byId[id] = (link, DateTimeOffset.UtcNow);
                if (!Equals(before, link)) changed();
            }
            catch (OperationCanceledException) { return; }
            catch (BellApiException error) when (error.Status == HttpStatusCode.NotFound) { var before = Of(id); byId[id] = (null, DateTimeOffset.UtcNow); if (before is not null) changed(); }
            catch (Exception) { }   // unreachable or refused: no badge now, asked again on the next change
            finally { reading.Remove(id); }
        }
    }
}
