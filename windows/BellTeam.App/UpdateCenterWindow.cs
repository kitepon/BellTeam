using System.Windows;
using System.Windows.Controls;
using BellTeam.Core;

namespace BellTeam.App;

public sealed class UpdateCenterWindow : EditorWindow
{
    private readonly Workspace workspace;
    private readonly UpdateCenter center;
    private UpdatePlan? plan;
    private UpdateInventory? inventory;
    public UpdateCenterWindow(Workspace workspace) : base("更新センター", workspace.ConnectionToken)
    {
        this.workspace = workspace;
        center = new(workspace.Management.Api, new SettingsStore(SettingsStore.UserDirectory));
        CloseButton.Content = "閉じる"; SaveButton.Visibility = Visibility.Collapsed;
        workspace.UpdatesChanged += Updated;
        Closed += (_, _) => workspace.UpdatesChanged -= Updated;
    }
    private void Updated() { if (!Busy) _ = InitializeAsync(); }
    public Task InitializeAsync() => RunAsync(async () => { inventory = await center.InventoryAsync(Token); Render(); return false; }, canClose: true);
    private static string Version(UpdateVersion? value) => value?.Version ?? "確認できません";
    private static string Comparison(UpdateComparison value) => value.State switch { "up_to_date" => "正式公開版と一致", "update_available" => "更新あり", "unavailable" => "更新情報を取得できません", "incompatible" => "互換性を確認できません", "unknown" => "確認不能", _ => "確認できない状態" };
    private void Text(Panel panel, string text) => panel.Children.Add(new TextBlock { Text = text, TextWrapping = TextWrapping.Wrap, Margin = new Thickness(0, 4, 0, 4) });
    private void Render()
    {
        Body.Children.Clear();
        Heading("BellTeam 更新センター");
        Text(Body, $"接続先: {workspace.Server}");
        Text(Body, inventory?.Notice.Message ?? "更新情報を確認できません。");
        ActionButton("更新情報を再取得", () => _ = InitializeAsync());
        foreach (var component in inventory?.Components ?? [])
        {
            var section = Section(component.Name);
            Text(section, component.Description);
            Text(section, $"稼働版: {Version(component.Current)}\n公開版: {Version(component.Published)}\n状態: {Comparison(component.Comparison)} {component.Comparison.Reason}\n変更内容: {(component.Changes.Length == 0 ? "未提供" : string.Join("\n", component.Changes))}");
            if (!component.Capability.Supported) Text(section, $"実行できません: {component.Capability.Reason}");
            var button = new Button { Content = "更新計画を確認", IsEnabled = component.Capability.Supported, HorizontalAlignment = HorizontalAlignment.Left };
            button.Click += async (_, _) => await MakePlanAsync(component.Id);
            section.Children.Add(button);
        }
        ActionButton("全体の更新計画を確認", () => _ = MakePlanAsync(null));
        foreach (var operation in new[] { inventory?.Operation, inventory?.PreviousOperation }.Where(value => value is not null).DistinctBy(value => value!.RequestId))
        {
            var section = Section("本体が保持する更新状態");
            Text(section, $"要求ID: {operation!.RequestId}\n受付: {operation.Admission} / 状態: {operation.Phase}\n実行: {operation.Execution} / 稼働確認: {operation.Verification}\n{operation.Error?.Code} {operation.Error?.Message}");
        }
        if (plan is { } selected)
        {
            var section = Section("確認する計画");
            Text(section, $"計画ID: {selected.PlanId}\n期限: {selected.ExpiresAt.LocalDateTime}\n影響: {selected.Impact.Description}\n互換性: {(selected.Compatibility.Compatible ? "確認済み" : selected.Compatibility.Reason)}\n実行可否: {(selected.Capability.Supported ? "対応" : selected.Capability.Reason)}");
            foreach (var target in selected.Targets) Text(section, $"{target.ComponentId}: {Version(target.Current)} → {Version(target.Published)}");
            var execute = new Button { Content = "この計画を実行", IsEnabled = selected.Capability.Supported && selected.Compatibility.Compatible && selected.ExpiresAt > DateTimeOffset.UtcNow, HorizontalAlignment = HorizontalAlignment.Left };
            execute.Click += async (_, _) =>
            {
                var confirmed = !selected.Impact.ContainerRestart || MessageBox.Show(DialogOwner, selected.Impact.Description + "\n再起動に同意して更新しますか？", "更新の確認", MessageBoxButton.YesNo) == MessageBoxResult.Yes;
                if (!confirmed) return;
                await RunAsync(async () => { try { await center.StartAsync(selected, confirmed, Token); plan = null; } catch { plan = null; throw; } return false; });
                Render();
            };
            section.Children.Add(execute);
        }
        foreach (var request in center.Requests)
        {
            var section = Section("保持した更新要求");
            var result = request.Result;
            Text(section, $"要求ID: {request.RequestId}\n計画ID: {request.PlanId}\n受付: {result?.Admission ?? (request.Rejection is null ? "unknown" : "rejected")} / 状態: {result?.Phase ?? "unknown"}\n実行: {result?.Execution ?? "unknown"} / 稼働確認: {result?.Verification ?? "unknown"}\n{result?.Error?.Code} {result?.Error?.Message} {request.Rejection}");
            var read = new Button { Content = "この要求の結果を確認", HorizontalAlignment = HorizontalAlignment.Left };
            read.Click += async (_, _) => { await RunAsync(async () => { await center.ReadAsync(request, Token); return false; }, canClose: true); Render(); };
            section.Children.Add(read);
        }
    }
    private Task MakePlanAsync(string? componentId) { plan = null; Render(); return RunAsync(async () => { plan = await center.PlanAsync(componentId, Token); Render(); return false; }); }
}
