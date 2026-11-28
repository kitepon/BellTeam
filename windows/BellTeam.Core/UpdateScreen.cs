using System.Globalization;

namespace BellTeam.Core;

public enum UpdateKind { Loading, Unreachable, Updating, Unconfirmed, Failed, Completed, Available, UpToDate, Waiting, Unknown }
public enum UpdateBadge { UpToDate, Available, Updating, Failed, Incompatible, Unknown }

// The Mac UpdateContent state and wording (ios/BellBot/BellBot/Views/UpdateView.swift), computed from the same inventory/operation data.
public static class UpdateScreen
{
    public static string BadgeText(UpdateBadge badge) => badge switch { UpdateBadge.UpToDate => CoreStrings.SettingsStatus_Update_5, UpdateBadge.Available => CoreStrings.SettingsStatus_Update_3, UpdateBadge.Updating => CoreStrings.SettingsStatus_Update_2, UpdateBadge.Failed => CoreStrings.OnePassword_BadgeText_3, UpdateBadge.Incompatible => CoreStrings.UpdateScreen_BadgeText_5, _ => CoreStrings.SettingsModels_RowText_2 };

    public static bool Completed(UpdateOperation value) => value is { Phase: "completed", Admission: "accepted", Execution: "succeeded", Verification: "succeeded" };
    public static bool Failure(UpdateOperation value) => value.Phase == "failed" || value.Execution == "failed" || value.Verification == "failed";
    // Unknown is never settled. A failed verification is a failure even when the server leaves phase/execution looser than the Mac's pair.
    public static bool Settled(UpdateOperation value) => value.Admission == "rejected" || Completed(value) || Failure(value);
    public static bool Unknown(UpdateOperation value) => value.Admission == "unknown" || value.Phase == "unknown";

    // The result read for a saved request wins while it is unsettled; otherwise the server's own current operation.
    public static UpdateOperation? Current(UpdateInventory? inventory, UpdateRequest[] requests)
        => requests.Where(item => item.Result is not null && !Settled(item.Result)).LastOrDefault()?.Result ?? inventory?.Operation;
    public static bool HasUnreadRequest(UpdateRequest[] requests) => requests.Any(item => item.Rejection is null && item.Result is null);

    public static UpdateComponent[] Candidates(UpdateInventory? inventory) => inventory?.Components.Where(item => item.Comparison.State == "update_available" && item.Capability.Supported).ToArray() ?? [];

    // A verified-or-absent publication check. A check that the server reports as failed or unconfirmed is not "latest".
    private static bool Unverified(UpdateComponent item) => item.Publication.ValueKind == System.Text.Json.JsonValueKind.Object && !(item.Publication.TryGetProperty("check", out var check) && check.ValueKind == System.Text.Json.JsonValueKind.Object && check.TryGetProperty("status", out var status) && status.GetString() == "verified");

    public static UpdateKind Kind(UpdateInventory? inventory, bool readFailed, UpdateOperation? current, bool unreadRequest)
    {
        if (inventory is null) return readFailed ? UpdateKind.Unreachable : UpdateKind.Loading;
        if (current is not null && !Settled(current)) return Unknown(current) ? UpdateKind.Unconfirmed : UpdateKind.Updating;
        if (unreadRequest) return UpdateKind.Unconfirmed;
        if (current is { Phase: "failed" } or { Execution: "failed" } or { Verification: "failed" }) return UpdateKind.Failed;
        if (Candidates(inventory).Length > 0) return UpdateKind.Available;
        if (current is not null && Completed(current)) return UpdateKind.Completed;
        if (inventory.Components.Length > 0 && inventory.Components.All(item => item.Comparison.State == "up_to_date" && !Unverified(item))) return UpdateKind.UpToDate;
        // Mac Status.waiting: everything else is current and these parts have no version for this body yet.
        if (Waiting(inventory).Length > 0 && inventory.Components.All(item => item.Comparison.State == "incompatible" || item.Comparison.State == "up_to_date" && !Unverified(item))) return UpdateKind.Waiting;
        return UpdateKind.Unknown;
    }

    public static UpdateComponent[] Waiting(UpdateInventory? inventory) => inventory?.Components.Where(item => item.Comparison.State == "incompatible").ToArray() ?? [];

    public static string PhaseText(string phase) => phase switch
    {
        "preparing" => CoreStrings.UpdateScreen_PhaseText_1, "applying" => CoreStrings.UpdateScreen_PhaseText_2, "reconnecting" => CoreStrings.UpdateScreen_PhaseText_3, "verifying" => CoreStrings.UpdateScreen_PhaseText_4,
        "completed" => CoreStrings.UpdateScreen_PhaseText_5, "failed" => CoreStrings.OnePassword_BadgeText_3, "unknown" => CoreStrings.UpdateScreen_PhaseText_7, _ => ""
    };
    public static string AdmissionText(string value) => value switch { "pending" => CoreStrings.UpdateScreen_AdmissionText_1, "accepted" => CoreStrings.UpdateScreen_AdmissionText_2, "rejected" => CoreStrings.UpdateScreen_AdmissionText_3, _ => CoreStrings.UpdateScreen_AdmissionText_4 };
    public static string OutcomeText(string value) => value switch { "pending" => CoreStrings.UpdateScreen_OutcomeText_1, "succeeded" => CoreStrings.UpdateScreen_OutcomeText_2, "failed" => CoreStrings.OnePassword_BadgeText_3, _ => CoreStrings.UpdateScreen_AdmissionText_4 };
    public static string ComparisonText(string value) => value switch { "up_to_date" => CoreStrings.UpdateScreen_ComparisonText_1, "update_available" => CoreStrings.SettingsStatus_Update_3, "unavailable" => CoreStrings.UpdateScreen_ComparisonText_3, "incompatible" => CoreStrings.UpdateScreen_ComparisonText_4, _ => CoreStrings.UpdateScreen_AdmissionText_4 };

    public static string ComponentName(UpdateInventory? inventory, string id) => inventory?.Components.FirstOrDefault(item => item.Id == id)?.Name ?? id;

    public static (string Title, string Detail) Hero(UpdateKind kind, UpdateInventory? inventory, UpdateOperation? current)
    {
        var candidates = Candidates(inventory);
        return kind switch
        {
            UpdateKind.Loading => (CoreStrings.UpdateScreen_Hero_1, CoreStrings.UpdateScreen_Hero_2),
            UpdateKind.Unreachable => (CoreStrings.UpdateScreen_Hero_3, CoreStrings.UpdateScreen_Hero_4),
            UpdateKind.Updating => (CoreStrings.UpdateScreen_Hero_5, CoreStrings.UpdateScreen_Hero_7((PhaseText(current?.Phase ?? "") is { Length: > 0 } phase ? phase : CoreStrings.UpdateScreen_Hero_5))),
            UpdateKind.Unconfirmed => (CoreStrings.UpdateScreen_Hero_8, CoreStrings.UpdateScreen_Hero_9),
            UpdateKind.Failed => (CoreStrings.UpdateScreen_Hero_10, CoreStrings.UpdateScreen_Hero_11),
            UpdateKind.Completed => (CoreStrings.UpdateScreen_Hero_12, CoreStrings.UpdateScreen_Hero_14(string.Join(CoreStrings.Approvals_CardRow_3, (current?.Plan.Targets ?? []).Select(target => ComponentName(inventory, target.ComponentId))))),
            UpdateKind.Available => candidates.Length == 1 ? (CoreStrings.UpdateScreen_Hero_15(candidates[0].Name), CoreStrings.UpdateScreen_Hero_16) : (CoreStrings.UpdateScreen_Hero_17(candidates.Length), CoreStrings.UpdateScreen_Hero_19(string.Join(CoreStrings.HarnessAccounts_LimitLine_2, candidates.Select(item => item.Name)))),
            UpdateKind.UpToDate => (CoreStrings.UpdateScreen_Hero_20, CoreStrings.UpdateScreen_Hero_21),
            UpdateKind.Waiting => (CoreStrings.UpdateScreen_Hero_22, CoreStrings.UpdateScreen_Hero_24(string.Join(CoreStrings.HarnessAccounts_LimitLine_2, Waiting(inventory).Select(item => item.Name)))),
            _ => (CoreStrings.UpdateScreen_Hero_3, CoreStrings.UpdateScreen_Hero_26)
        };
    }

    // Updating when the current operation targets the part and is running, then the server's own tone, then the comparison.
    public static UpdateBadge Badge(UpdateComponent component, UpdateOperation? current)
    {
        // An operation whose phase or admission is unknown is a result we cannot confirm, never a running job.
        if (current is not null && !Settled(current) && current.Plan.Targets.Any(target => target.ComponentId == component.Id)) return Unknown(current) ? UpdateBadge.Unknown : UpdateBadge.Updating;
        switch (component.Part?.Tone) { case "updating": return UpdateBadge.Updating; case "attention": return UpdateBadge.Failed; }
        return component.Comparison.State switch { "up_to_date" => UpdateBadge.UpToDate, "update_available" => UpdateBadge.Available, "incompatible" => UpdateBadge.Incompatible, _ => UpdateBadge.Unknown };
    }

    public static string? Moment(string? value) => DateTimeOffset.TryParse(value, CultureInfo.InvariantCulture, DateTimeStyles.None, out var at) ? at.ToLocalTime().ToString(CoreStrings.UpdateScreen_Moment_1) : null;

    // Never shows a hash: built-in, a named version, the publish time, or the latest/current wording.
    public static string VersionName(UpdateComponent component)
    {
        if (component.Current is not { } current) return CoreStrings.UpdateScreen_VersionName_1;
        if (current.Origin == "builtin") return CoreStrings.UpdateScreen_VersionName_2;
        var hash = current.Version.Length >= 12 && current.Version.All(Uri.IsHexDigit);
        if (!hash) return CoreStrings.UpdateScreen_VersionName_3(current.Version);
        if (component.Comparison.State == "up_to_date" && Moment(component.PublishedAt) is { } published) return CoreStrings.UpdateScreen_VersionName_4(published);
        return component.Comparison.State == "up_to_date" ? CoreStrings.UpdateScreen_VersionName_5 : CoreStrings.UpdateScreen_VersionName_6;
    }
    public static string? LastUpdated(UpdateComponent component) => component.Part?.LatestJob is { Outcome: "succeeded" } job && Moment(job.At) is { } at ? CoreStrings.UpdateScreen_LastUpdated_1(at) : null;

    public static string[] Changes(UpdateInventory? inventory)
        => (inventory?.Components ?? []).Where(item => item.Comparison.State == "update_available").SelectMany(item => item.Changes).Distinct().ToArray();

    public static UpdateJob[] Jobs(UpdateInventory? inventory, UpdateOperation? current)
        => (current?.Jobs ?? []).Concat(inventory?.Operation?.Jobs ?? []).Concat(inventory?.Jobs ?? []).DistinctBy(job => job.Kind + ":" + job.JobId).ToArray();

    // Known plans use plain wording. An unknown action or scope is shown as the server sent it.
    public static (string Title, string Button, string? ServerPlan) PlanWording(UpdatePlan plan)
    {
        if (plan.Action is null or "update" or "rollback" && plan.Scope is "all" or "component") return plan.Action == "rollback" ? (CoreStrings.UpdateScreen_PlanWording_1, CoreStrings.UpdateScreen_PlanWording_2, null) : (CoreStrings.UpdateScreen_PlanWording_3, CoreStrings.UpdateScreen_PlanWording_4, null);
        var targets = plan.Targets.Select(target => $"{target.ComponentId}: {Label(target.Current)} → {Label(target.Published)}");
        return (CoreStrings.UpdateScreen_PlanWording_5, CoreStrings.UpdateScreen_PlanWording_6, string.Join("\n", new[] { $"action: {plan.Action ?? CoreStrings.OnePassword_ConnectionLine_2} / scope: {plan.Scope}", $"containerRestart: {plan.Impact.ContainerRestart}" }.Concat(targets)));
    }
    public static string Label(UpdateVersion? version) => version is null ? CoreStrings.SettingsModels_RowText_2 : (version.Origin == "builtin" ? CoreStrings.UpdateScreen_Label_2 : "") + (version.Version.Length >= 40 ? version.Version[..12] : version.Version);
}
