using System.Text.Json;
using BellTeam.Core;

namespace BellTeam.Linux;

/// <summary>
/// Where a decision came from, decided on the client (client-v0.5.md 6.2, the four rules of contract/approvals-contract.md "How origin.kind is decided"); every client's test reads contract/fixtures/origin-cases.json.
/// Visibility never depends on the kind: nothing is hidden (Owner 2026-11-15).
/// </summary>
internal static class ApprovalOriginRule
{
    private static readonly string[] Clients = ["claude-code", "codex", "cursor", "grok", "claude.ai", "chatgpt", "other"];

    private static string? Str(JsonElement e, string name) => e.ValueKind == JsonValueKind.Object && e.TryGetProperty(name, out var v) && v.ValueKind == JsonValueKind.String && v.GetString() is { Length: > 0 } s ? s : null;

    /// <param name="source">The decision's source object (Approval Box v0.38).</param>
    /// <param name="roster">The BellTeam members the app already holds (id, name).</param>
    internal static (ApprovalOrigin Origin, ApprovalRequester? Requester) Of(JsonElement source, IReadOnlyList<(string Id, string Name)> roster)
    {
        string? client = Str(source, "client"), label = Str(source, "session_label"), botId = Str(source, "requester_bot_id"), requester = Str(source, "requester");
        // An unknown client string draws as 「その他」 (the API's own rule for unknown values).
        var shownClient = client is null ? null : Clients.Contains(client) ? client : "other";
        ApprovalOrigin Origin(string kind, string basis) => new()
        {
            Kind = kind, Basis = basis, Client = shownClient, Tool = DeviceDecisionView.ToolOf(shownClient ?? ""), SessionLabel = label, WorkLabel = Str(source, "work_label"), ConnectionLabel = Str(source, "connection_label"), Via = Str(source, "via"),
        };
        if (botId is not null && roster.FirstOrDefault(member => member.Id == botId) is { Id: not null } byId) return (Origin("bellteam", "botId"), new() { BotId = byId.Id, Name = byId.Name });
        if (requester is not null && roster.FirstOrDefault(member => member.Name == requester) is { Id: not null } byName) return (Origin("bellteam", "name"), new() { BotId = byName.Id, Name = byName.Name });
        return (Origin(client is not null || label is not null ? "external" : "unknown", "none"), null);
    }
}
