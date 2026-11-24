using System.Net;

namespace BellTeam.Core;

// A seat stopped on a tool-approval prompt, answered inside BellTeam (seat-approval-clients; Kiro's contract docs/architecture/modules/execution/seat-approvals.md, Owner 2026-11-24).
// The same entry, the same two buttons and the literal command on every client; the first answer wins. Never a token, never an id on screen.
public sealed record SeatApprovalChoice { public required string Decision { get; init; } public required string Label { get; init; } }

public sealed record SeatApproval
{
    public required string Id { get; init; }
    public required string BotId { get; init; }
    public string? BotName { get; init; }
    public string? Harness { get; init; }
    /// <summary>Null for a TUI Claude seat: Aiterm gives no text, the client says to look at the Bot's screen.</summary>
    public string? Tool { get; init; }
    /// <summary>The literal command, secret-masked and cut at 2000 characters by the server; null for a TUI Claude seat.</summary>
    public string? Command { get; init; }
    public string? Reason { get; init; }
    public DateTimeOffset? Since { get; init; }
    public SeatApprovalChoice[]? Choices { get; init; }
    /// <summary>"filed": an Approval Box card exists too (the entry here stays).</summary>
    public string? Card { get; init; }

    /// <summary>The two buttons: the server's choices (approve_once first), the contract's labels when it sent none.</summary>
    public IReadOnlyList<SeatApprovalChoice> Buttons => Choices is { Length: > 0 } ? Choices : SeatApprovalText.DefaultChoices;
}

public sealed record SeatApprovalsResponse { public SeatApproval[] Approvals { get; init; } = []; }

public enum SeatApprovalResult { Answered, Closed, Failed }
/// <summary>What an answer came to and the plain line to show (null when it was answered).</summary>
public sealed record SeatApprovalOutcome(SeatApprovalResult Result, string? Text);

public static class SeatApprovalText
{
    public const string Heading = "承認を待っています", Badge = "承認待ち", SeeScreen = "Botの画面を見てください",
        Closed = "別の場所で答えられたか、もう承認待ちではありません。", Failed = "いまは送れませんでした。もう一度押してください。", Sending = "答えを送っています…";
    public static readonly SeatApprovalChoice[] DefaultChoices = [new() { Decision = "approve_once", Label = "1回だけ許可する" }, new() { Decision = "deny", Label = "許可しない" }];
    /// <summary>The one line over the command: the tool and which harness stopped, e.g. 「Bash · Claude Code」; just the harness when the seat gave no tool.</summary>
    public static string Source(SeatApproval approval)
    {
        var harness = approval.Harness switch { "claude" => "Claude Code", "codex" => "Codex", { Length: > 0 } other => other, _ => null };
        return string.Join(" · ", new[] { approval.Tool, harness }.Where(part => !string.IsNullOrWhiteSpace(part)));
    }
    public static string CommandText(SeatApproval approval) => string.IsNullOrEmpty(approval.Command) ? SeeScreen : approval.Command;
}

public static class SeatApprovalsApi
{
    /// <summary>The open entries, oldest first. A body without the route (404), one that cannot say (503, 403) or a failed read is no entry: the list refresh never fails because of it. Cancel passes.</summary>
    public static async Task<SeatApproval[]> SeatApprovalsAsync(this BellApi api, CancellationToken token = default)
    {
        try { return (await api.GetAsync<SeatApprovalsResponse>("/api/seat-approvals", token)).Approvals.OrderBy(a => a.Since ?? DateTimeOffset.MinValue).ToArray(); }
        catch (OperationCanceledException) when (token.IsCancellationRequested) { throw; }
        catch (Exception) { return []; }
    }

    /// <summary>One answer, never resent by itself (the first answer wins). 409 SEAT_APPROVAL_CLOSED is "answered elsewhere or gone"; every other failure is the plain failure line.</summary>
    public static async Task<SeatApprovalOutcome> AnswerSeatApprovalAsync(this BellApi api, string id, string decision, CancellationToken token = default)
    {
        try { await api.PostAsync<System.Text.Json.JsonElement>($"/api/seat-approvals/{Uri.EscapeDataString(id)}/answer", new { decision }, token); return new(SeatApprovalResult.Answered, null); }
        catch (BellApiException error) when (error.Code == "SEAT_APPROVAL_CLOSED" || error.Status == HttpStatusCode.Conflict) { return new(SeatApprovalResult.Closed, SeatApprovalText.Closed); }
        catch (OperationCanceledException) when (token.IsCancellationRequested) { throw; }
        catch (Exception) { return new(SeatApprovalResult.Failed, SeatApprovalText.Failed); }
    }
}
