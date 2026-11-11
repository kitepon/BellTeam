using System.Globalization;

namespace BellTeam.Core;

public enum UpdateKind { Loading, Unreachable, Updating, Unconfirmed, Failed, Completed, Available, UpToDate, Waiting, Unknown }
public enum UpdateBadge { UpToDate, Available, Updating, Failed, Incompatible, Unknown }

// The Mac UpdateContent state and wording (ios/BellBot/BellBot/Views/UpdateView.swift), computed from the same inventory/operation data.
public static class UpdateScreen
{
    public static string BadgeText(UpdateBadge badge) => badge switch { UpdateBadge.UpToDate => "最新", UpdateBadge.Available => "更新あり", UpdateBadge.Updating => "更新中", UpdateBadge.Failed => "失敗", UpdateBadge.Incompatible => "使えない版", _ => "確認できません" };

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
        "preparing" => "準備しています", "applying" => "新しい版に切り替えています", "reconnecting" => "再接続しています", "verifying" => "動作を確かめています",
        "completed" => "更新完了", "failed" => "失敗", "unknown" => "結果確認中", _ => ""
    };
    public static string AdmissionText(string value) => value switch { "pending" => "受付中", "accepted" => "受付済み", "rejected" => "未受付", _ => "確認不能" };
    public static string OutcomeText(string value) => value switch { "pending" => "未確認", "succeeded" => "成功", "failed" => "失敗", _ => "確認不能" };
    public static string ComparisonText(string value) => value switch { "up_to_date" => "公開版と一致", "update_available" => "更新あり", "unavailable" => "取得できません", "incompatible" => "互換性を確認できません", _ => "確認不能" };

    public static string ComponentName(UpdateInventory? inventory, string id) => inventory?.Components.FirstOrDefault(item => item.Id == id)?.Name ?? id;

    public static (string Title, string Detail) Hero(UpdateKind kind, UpdateInventory? inventory, UpdateOperation? current)
    {
        var candidates = Candidates(inventory);
        return kind switch
        {
            UpdateKind.Loading => ("確認しています", "最新の状態かどうかを確かめています。"),
            UpdateKind.Unreachable => ("更新を確認できませんでした", "接続を確かめて、もう一度お試しください。"),
            UpdateKind.Updating => ("更新しています", (PhaseText(current?.Phase ?? "") is { Length: > 0 } phase ? phase : "更新しています") + "。完了まで、この画面を閉じても大丈夫です。"),
            UpdateKind.Unconfirmed => ("更新の結果を確認中", "更新の結果を、まだ確認できていません。"),
            UpdateKind.Failed => ("更新できませんでした", "更新を完了できませんでした。理由は「詳細」で確認できます。"),
            UpdateKind.Completed => ("更新しました", string.Join("、", (current?.Plan.Targets ?? []).Select(target => ComponentName(inventory, target.ComponentId))) + "を新しい版にしました。"),
            UpdateKind.Available => candidates.Length == 1 ? (candidates[0].Name + "を更新できます", "新しい版を使えます。") : (candidates.Length + "つ更新できます", string.Join("・", candidates.Select(item => item.Name)) + "に新しい版があります。"),
            UpdateKind.UpToDate => ("すべて最新です", "今のところ、新しい更新はありません。"),
            UpdateKind.Waiting => ("更新できるものはすべて最新です", string.Join("・", Waiting(inventory).Select(item => item.Name)) + "は、いまの本体に合う版がまだありません。合う版が出ると、ここで更新できます。"),
            _ => ("更新を確認できませんでした", "時間をおいて、もう一度確認してください。")
        };
    }

    // Updating when the current operation targets the part, then the server's own tone, then the comparison.
    public static UpdateBadge Badge(UpdateComponent component, UpdateOperation? current)
    {
        if (current is not null && !Settled(current) && current.Plan.Targets.Any(target => target.ComponentId == component.Id)) return UpdateBadge.Updating;
        switch (component.Part?.Tone) { case "updating": return UpdateBadge.Updating; case "attention": return UpdateBadge.Failed; }
        return component.Comparison.State switch { "up_to_date" => UpdateBadge.UpToDate, "update_available" => UpdateBadge.Available, "incompatible" => UpdateBadge.Incompatible, _ => UpdateBadge.Unknown };
    }

    public static string? Moment(string? value) => DateTimeOffset.TryParse(value, CultureInfo.InvariantCulture, DateTimeStyles.None, out var at) ? at.ToLocalTime().ToString("M月d日 H\\:mm", CultureInfo.InvariantCulture) : null;

    // Never shows a hash: built-in, a named version, the publish time, or the latest/current wording.
    public static string VersionName(UpdateComponent component)
    {
        if (component.Current is not { } current) return "版を確認できません";
        if (current.Origin == "builtin") return "最初から入っている版";
        var hash = current.Version.Length >= 12 && current.Version.All(Uri.IsHexDigit);
        if (!hash) return "版 " + current.Version;
        if (component.Comparison.State == "up_to_date" && Moment(component.PublishedAt) is { } published) return published + " 公開の版";
        return component.Comparison.State == "up_to_date" ? "公開中の最新版" : "今の版";
    }
    public static string? LastUpdated(UpdateComponent component) => component.Part?.LatestJob is { Outcome: "succeeded" } job && Moment(job.At) is { } at ? at + " に更新" : null;

    public static string[] Changes(UpdateInventory? inventory)
        => (inventory?.Components ?? []).Where(item => item.Comparison.State == "update_available").SelectMany(item => item.Changes).Distinct().ToArray();

    public static UpdateJob[] Jobs(UpdateInventory? inventory, UpdateOperation? current)
        => (current?.Jobs ?? []).Concat(inventory?.Operation?.Jobs ?? []).Concat(inventory?.Jobs ?? []).DistinctBy(job => job.Kind + ":" + job.JobId).ToArray();

    // Known plans use plain wording. An unknown action or scope is shown as the server sent it.
    public static (string Title, string Button, string? ServerPlan) PlanWording(UpdatePlan plan)
    {
        if (plan.Action is null or "update" or "rollback" && plan.Scope is "all" or "component") return plan.Action == "rollback" ? ("戻す前の確認", "戻す", null) : ("更新の前に", "更新を始める", null);
        var targets = plan.Targets.Select(target => $"{target.ComponentId}: {Label(target.Current)} → {Label(target.Published)}");
        return ("サーバーの計画を確認", "実行する", string.Join("\n", new[] { $"action: {plan.Action ?? "なし"} / scope: {plan.Scope}", $"containerRestart: {plan.Impact.ContainerRestart}" }.Concat(targets)));
    }
    public static string Label(UpdateVersion? version) => version is null ? "確認できません" : (version.Origin == "builtin" ? "内蔵版 " : "") + (version.Version.Length >= 40 ? version.Version[..12] : version.Version);
}
