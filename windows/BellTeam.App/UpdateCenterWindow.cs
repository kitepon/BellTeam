using System.Windows;
using System.Windows.Controls;
using System.Windows.Media;
using BellTeam.Core;

namespace BellTeam.App;

public sealed class UpdateCenterWindow : EditorWindow
{
    private readonly Workspace workspace;
    private readonly UpdateCenter center;
    private UpdatePlan? plan;
    private UpdateInventory? inventory;
    private string? loadError;
    private bool actionFailed;
    private bool selecting;
    public UpdateCenterWindow(Workspace workspace, SettingsStore? settings = null) : base("更新", workspace.ConnectionToken)
    {
        this.workspace = workspace;
        center = new(workspace.Management.Api, settings ?? new SettingsStore(SettingsStore.UserDirectory));
        CloseButton.Content = "閉じる"; SaveButton.Visibility = Visibility.Collapsed;
        workspace.UpdatesChanged += Updated;
        Closed += (_, _) => workspace.UpdatesChanged -= Updated;
    }
    private void Updated() { if (!Busy) _ = InitializeAsync(); }
    public Task InitializeAsync() => RunAsync(async () =>
    {
        try { inventory = await center.InventoryAsync(Token); loadError = null; actionFailed = false; }
        catch (OperationCanceledException) when (Token.IsCancellationRequested) { throw; }
        catch (Exception error) { inventory = null; loadError = error.Message; }
        Render(); return false;
    }, canClose: true);
    private static string Version(UpdateVersion? value) => value?.Version ?? "未取得";
    private static string? PublicVersion(UpdateVersion? value) => value is not null && System.Text.RegularExpressions.Regex.IsMatch(value.Version, @"^(?:v?\d+(?:\.\d+)+(?:[-+][\w.-]+)?|\d{4}-\d{2}-\d{2})$", System.Text.RegularExpressions.RegexOptions.IgnoreCase) ? value.Version : null;
    private static string Comparison(UpdateComparison value) => value.State switch { "up_to_date" => "最新", "update_available" => "更新あり", "unavailable" => "未取得", "incompatible" => "互換性を確認できません", "unknown" => "確認できません", _ => "確認できません" };
    private static bool Verified(System.Text.Json.JsonElement publication) => publication.ValueKind == System.Text.Json.JsonValueKind.Object && publication.TryGetProperty("check", out var check) && check.ValueKind == System.Text.Json.JsonValueKind.Object && check.TryGetProperty("status", out var status) && status.ValueKind == System.Text.Json.JsonValueKind.String && status.GetString() == "verified";
    private static void Text(Panel panel, string text, int size = 15, Brush? color = null, double top = 4) => panel.Children.Add(new TextBlock { Text = text, FontSize = size, Foreground = color ?? Brushes.DimGray, TextWrapping = TextWrapping.Wrap, Margin = new Thickness(0, top, 0, 4) });
    private static UpdateRequest? Unconfirmed(UpdateRequest[] requests) => requests.LastOrDefault(item => item.Rejection is null && (item.Result is null || item.Result.Admission == "unknown" || item.Result.Phase == "unknown"));
    private void Render()
    {
        Body.Children.Clear();
        var requests = center.Requests;
        var operation = inventory?.Operation;
        var unknown = Unconfirmed(requests) ?? (operation is { Admission: "unknown" } or { Phase: "unknown" } ? new UpdateRequest(workspace.Server, operation.RequestId, operation.Plan.PlanId, operation) : null);
        var running = operation is { Admission: "accepted", Phase: "preparing" or "applying" or "reconnecting" or "verifying" };
        if (running) { plan = null; selecting = false; }
        var failed = operation is { Phase: "failed" } or { Execution: "failed" } or { Verification: "failed" };
        var updates = inventory?.Components.Where(item => item.Comparison.State == "update_available").ToArray() ?? [];
        var latest = inventory is not null && inventory.Components.Length > 0 && inventory.Components.All(item => item.Comparison.State == "up_to_date" && Verified(item.Publication));
        var completed = operation is { Phase: "completed", Execution: "succeeded", Verification: "succeeded", Plan.Targets.Length: > 0 };
        var completedNames = completed ? string.Join("、", operation!.Plan.Targets.Select(target => inventory?.Components.FirstOrDefault(component => component.Id == target.ComponentId)?.Name ?? "選んだ対象")) : "";
        var title = plan is not null ? "更新する内容を確認" : selecting ? "更新するものを選ぶ" : running ? "更新しています" : unknown is not null ? "更新の結果を確認中" : failed ? "更新を完了できませんでした" : actionFailed || inventory?.Notice.State == "attention" ? "更新を確認できませんでした" : updates.Length > 0 ? "更新があります" : completed ? completedNames + "を更新しました" : latest ? "最新の状態です" : "更新を確認できませんでした";
        var description = plan is not null ? "この内容で更新します。" : running ? operation!.Phase switch { "preparing" => "更新の準備をしています。", "applying" => "新しい版に切り替えています。", "reconnecting" => "接続が戻るのを待っています。", _ => "更新後の動作を確認しています。" } : unknown is not null ? "更新の結果をまだ確認できません。" : failed || actionFailed || inventory?.Notice.State == "attention" ? "状態を確認して、もう一度お試しください。" : updates.Length > 0 && !updates.Any(item => item.Capability.Supported) ? "この更新は現在実行できません。状態を確認してください。" : updates.Length > 0 ? "新しい変更を確認してから、更新を始められます。" : completed ? "選んだ更新が完了しました。" : latest ? "BellTeamは最新の状態です。" : "接続を確認して、もう一度お試しください。";

        Text(Body, "BELLTEAM  /  更新", 12, Brushes.SlateGray, 4);
        Text(Body, "アップデート", 30, Brushes.Black, 4);
        Text(Body, "いつものチームを、より快適に。", 15, Brushes.SlateGray, 0);
        var card = new StackPanel();
        var hero = new Border { Background = Brushes.White, BorderBrush = new SolidColorBrush(Color.FromRgb(229, 227, 240)), BorderThickness = new Thickness(1), CornerRadius = new CornerRadius(20), Padding = new Thickness(24), Margin = new Thickness(0, 22, 0, 0), Child = card };
        Body.Children.Add(hero);
        Text(card, plan is not null || selecting ? "更新の確認" : running ? "更新中" : unknown is not null || failed || inventory?.Notice.State == "attention" ? "要確認" : updates.Length > 0 ? "新しいお知らせ" : latest ? "更新状況" : "接続を確認", 12, new SolidColorBrush(Color.FromRgb(97, 71, 212)), 0);
        Text(card, title, 24, Brushes.Black, 8);
        var versions = updates.Select(item => PublicVersion(item.Published)).Distinct().ToArray();
        if (plan is null && !selecting && !running && unknown is null && !failed && !actionFailed && versions is [string publicVersion]) Text(card, "公開版 " + publicVersion, 14, Brushes.SlateGray, 4);
        Text(card, description, 15, Brushes.SlateGray, 5);
        if (plan is { } selected)
        {
            var names = selected.Targets.Select(target => inventory?.Components.FirstOrDefault(component => component.Id == target.ComponentId)?.Name ?? "更新対象");
            Text(card, "対象: " + string.Join("、", names), 15, Brushes.DimGray, 12);
            Text(card, selected.Impact.Description, 15, Brushes.DimGray, 14);
            if (!selected.Compatibility.Compatible || !selected.Capability.Supported) Text(card, "この更新は現在実行できません。詳細を確認してください。", 15, Brushes.Firebrick, 8);
            var execute = Primary(card, "更新を始める", async () =>
            {
                var confirmed = !selected.Impact.ContainerRestart || MessageBox.Show(DialogOwner, selected.Impact.Description + "\n再起動に同意して更新しますか？", "更新の確認", MessageBoxButton.YesNo) == MessageBoxResult.Yes;
                if (!confirmed) return;
                await RunAsync(async () => { try { await center.StartAsync(selected, confirmed, Token); actionFailed = false; } catch (Exception error) { loadError = error.Message; actionFailed = true; } plan = null; return false; });
                Render();
            });
            execute.IsEnabled = selected.Capability.Supported && selected.Compatibility.Compatible && selected.ExpiresAt > DateTimeOffset.UtcNow;
        }
        else if (selecting)
        {
            foreach (var component in updates.Where(item => item.Capability.Supported))
            {
                var choice = new Button { Content = component.Name, HorizontalAlignment = HorizontalAlignment.Left };
                choice.Click += async (_, _) => await MakePlanAsync(component.Id); card.Children.Add(choice);
            }
            var all = new Button { Content = "まとめて更新", HorizontalAlignment = HorizontalAlignment.Left };
            all.Click += async (_, _) => await MakePlanAsync(null); card.Children.Add(all);
            var back = new Button { Content = "戻る", HorizontalAlignment = HorizontalAlignment.Left };
            back.Click += (_, _) => { selecting = false; Render(); }; card.Children.Add(back);
        }
        else if (running) Primary(card, "状況を確認", InitializeAsync);
        else if (unknown is not null) Primary(card, "状況を確認", async () => { await RunAsync(async () => { try { await center.ReadAsync(unknown, Token); actionFailed = false; } catch (Exception error) { loadError = error.Message; actionFailed = true; } return false; }, canClose: true); Render(); });
        else if (failed && operation is not null) Primary(card, "状況を確認", async () => { await RunAsync(async () => { try { await center.ReadAsync(new(workspace.Server, operation.RequestId, operation.Plan.PlanId, operation), Token); actionFailed = false; } catch (Exception error) { loadError = error.Message; actionFailed = true; } return false; }, canClose: true); Render(); });
        else if (updates.Length == 0 || !updates.Any(item => item.Capability.Supported)) Primary(card, "もう一度確認", InitializeAsync);
        else Primary(card, "更新する", () => { if (updates.Length == 1) return MakePlanAsync(updates[0].Id); selecting = true; Render(); return Task.CompletedTask; });

        var changes = updates.SelectMany(item => item.Changes).Where(value => !string.IsNullOrWhiteSpace(value) && !System.Text.RegularExpressions.Regex.IsMatch(value, @"[a-f0-9]{40,64}|sha256:|\b(?:commit|schema|API|CLI)\b|開発者", System.Text.RegularExpressions.RegexOptions.IgnoreCase)).Distinct().ToArray();
        if (changes.Length > 0 && updates.Length > 0 && plan is null && !selecting && !running && unknown is null && !failed && !actionFailed)
        {
            Text(Body, "今回の更新", 19, Brushes.Black, 25);
            var section = new StackPanel();
            Body.Children.Add(new Border { Background = Brushes.White, BorderBrush = new SolidColorBrush(Color.FromRgb(229, 227, 240)), BorderThickness = new Thickness(1), CornerRadius = new CornerRadius(18), Padding = new Thickness(20), Margin = new Thickness(0, 8, 0, 0), Child = section });
            foreach (var change in changes) Text(section, "•  " + change, 15, Brushes.DimGray, 0);
        }
        var details = new StackPanel { Margin = new Thickness(12, 8, 0, 0) };
        var expander = new Expander { Header = "詳細を表示", Content = details, Margin = new Thickness(0, 24, 0, 0), FontSize = 14 };
        Body.Children.Add(expander);
        Text(details, $"接続先: {workspace.Server}", 13);
        if (loadError is not null) Text(details, loadError, 13, Brushes.Firebrick);
        foreach (var component in inventory?.Components ?? [])
        {
            Text(details, $"{component.Name} · {Comparison(component.Comparison)}\n稼働版: {Version(component.Current)}\n公開版: {Version(component.Published)}\n変更内容: {string.Join(" / ", component.Changes)}\n{component.Comparison.Reason} {component.Capability.Reason}", 13, Brushes.DimGray, 12);
            var button = new Button { Content = "この対象の更新を確認", IsEnabled = component.Capability.Supported, HorizontalAlignment = HorizontalAlignment.Left };
            button.Click += async (_, _) => await MakePlanAsync(component.Id);
            details.Children.Add(button);
        }
        if (unknown is not null && updates.Any(item => item.Capability.Supported))
        {
            var next = new Button { Content = "新しい更新を確認", HorizontalAlignment = HorizontalAlignment.Left };
            next.Click += async (_, _) => await MakePlanAsync(null); details.Children.Add(next);
        }
        foreach (var item in new[] { inventory?.Operation, inventory?.PreviousOperation }.Where(value => value is not null).DistinctBy(value => value!.RequestId))
            Text(details, $"要求ID: {item!.RequestId}\n受付: {item.Admission} / 状態: {item.Phase}\n実行: {item.Execution} / 稼働確認: {item.Verification}\n{item.Error?.Code} {item.Error?.Message}", 13, Brushes.DimGray, 12);
        if (plan is { } detailPlan)
        {
            Text(details, $"計画ID: {detailPlan.PlanId}\n期限: {detailPlan.ExpiresAt.LocalDateTime}\n互換性: {detailPlan.Compatibility.Reason}\n実行可否: {detailPlan.Capability.Reason}", 13, Brushes.DimGray, 12);
            foreach (var target in detailPlan.Targets) Text(details, $"{target.ComponentId}: {Version(target.Current)} → {Version(target.Published)}", 13);
        }
        foreach (var request in requests)
        {
            var result = request.Result;
            Text(details, $"要求ID: {request.RequestId}\n計画ID: {request.PlanId}\n受付: {result?.Admission ?? (request.Rejection is null ? "unknown" : "rejected")} / 状態: {result?.Phase ?? "unknown"}\n実行: {result?.Execution ?? "unknown"} / 稼働確認: {result?.Verification ?? "unknown"}\n{result?.Error?.Code} {result?.Error?.Message} {request.Rejection}", 13, Brushes.DimGray, 12);
            var read = new Button { Content = "この更新の結果を確認", HorizontalAlignment = HorizontalAlignment.Left };
            read.Click += async (_, _) => { await RunAsync(async () => { try { await center.ReadAsync(request, Token); actionFailed = false; } catch (Exception error) { loadError = error.Message; actionFailed = true; } return false; }, canClose: true); Render(); };
            details.Children.Add(read);
        }
    }
    private static Button Primary(Panel panel, string label, Func<Task> action)
    {
        var button = new Button { Content = label, HorizontalAlignment = HorizontalAlignment.Left, Margin = new Thickness(0, 20, 0, 0), Padding = new Thickness(22, 12, 22, 12) };
        button.SetResourceReference(StyleProperty, "PrimaryButton"); button.Click += async (_, _) => await action(); panel.Children.Add(button); return button;
    }
    private Task MakePlanAsync(string? componentId) { selecting = false; plan = null; Render(); return RunAsync(async () => { try { plan = await center.PlanAsync(componentId, Token); actionFailed = false; } catch (Exception error) { loadError = error.Message; actionFailed = true; } Render(); return false; }); }
}
