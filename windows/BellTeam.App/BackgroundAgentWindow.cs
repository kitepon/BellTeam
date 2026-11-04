using System.Windows;
using System.Windows.Controls;
using BellTeam.Core;

namespace BellTeam.App;

public sealed class BackgroundAgentWindow : EditorWindow
{
    private readonly Workspace workspace;
    private readonly BackgroundAgentApi api;
    private readonly ComboBox harness = new() { DisplayMemberPath = "Label", SelectedValuePath = "Id" };
    private readonly ComboBox model = new() { DisplayMemberPath = "Label", SelectedValuePath = "Id" };
    private readonly ComboBox effort = new() { DisplayMemberPath = "Label", SelectedValuePath = "Id" };
    private readonly TextBlock notice = new() { TextWrapping = TextWrapping.Wrap, Margin = new Thickness(0, 12, 0, 8) };
    private Dictionary<string, HarnessModels> catalog = [];
    private BackgroundAgentState? initial;
    private bool rendering;

    public BackgroundAgentWindow(Workspace workspace) : base("仕事の要約", workspace.ConnectionToken)
    {
        this.workspace = workspace;
        api = new(workspace.Management.Api);
        Closed += (_, _) => workspace.BackgroundAgentChanged -= OnChanged;
    }

    public async Task InitializeAsync()
    {
        SaveButton.IsEnabled = false;
        try
        {
            initial = await api.ReadAsync(Token);
            if (initial is null) { Status.Text = "接続先はこの設定に対応していません。"; return; }
            catalog = (await workspace.Management.Api.GetAsync<ModelsResponse>("/api/models", Token)).Models;
            Heading("仕事の要約に使うAI");
            Body.Children.Add(new TextBlock { Text = "チーム全体の仕事を、一人の背景エージェントが要約します。", TextWrapping = TextWrapping.Wrap });
            Add("ハーネス", harness); Add("モデル", model); Add("エフォート", effort); Body.Children.Add(notice);
            harness.ItemsSource = new[] { new FormOption("claude", "Claude"), new FormOption("codex", "Codex"), new FormOption("grok", "Grok"), new FormOption("cursor", "Cursor"), new FormOption("antigravity", "Antigravity") };
            harness.SelectionChanged += (_, _) => { if (!rendering) RenderModels(null, null); };
            model.SelectionChanged += (_, _) => { if (!rendering) RenderEfforts(null); };
            effort.SelectionChanged += (_, _) => { if (!rendering) UpdateSave(); };
            rendering = true; harness.SelectedValue = initial.Selection?.Harness; rendering = false;
            RenderModels(initial.Selection?.Model, initial.Selection?.ReasoningEffort);
            SaveAction = SaveAsync;
            workspace.BackgroundAgentChanged += OnChanged;
        }
        catch (OperationCanceledException) when (Token.IsCancellationRequested) { }
        catch (Exception error) { Status.Text = "設定を読み取れませんでした。\n" + error.Message; }
    }

    private void Add(string label, ComboBox control)
    {
        Body.Children.Add(new TextBlock { Text = label, Margin = new Thickness(0, 12, 0, 5) });
        System.Windows.Automation.AutomationProperties.SetName(control, label);
        Body.Children.Add(control);
    }

    private void RenderModels(string? selected, string? selectedEffort)
    {
        rendering = true;
        var key = harness.SelectedValue as string;
        catalog.TryGetValue(key ?? "", out var options);
        var choices = (options?.Models ?? []).Select(item => new FormOption(item.Id, item.Id)).ToList();
        if (selected is not null && choices.All(item => item.Id != selected)) choices.Add(new(selected, selected + "（現在の設定・候補外）"));
        model.ItemsSource = choices; model.SelectedValue = selected;
        notice.Text = options?.Error?.Message ?? (key is not null && options is null ? "モデル候補を取得できません。" : "");
        rendering = false; RenderEfforts(selectedEffort);
    }

    private void RenderEfforts(string? selected)
    {
        rendering = true;
        var key = harness.SelectedValue as string;
        var choice = key is not null && catalog.TryGetValue(key, out var options) ? options.Models.FirstOrDefault(item => item.Id == model.SelectedValue as string) : null;
        var choices = choice?.Efforts.Select(item => new FormOption(item, item)).ToList() ?? [];
        if (choice is not null && choice.Efforts.Length == 0) choices.Add(new("", "既定"));
        if (selected is not null && choices.All(item => item.Id != selected)) choices.Add(new(selected, selected + "（現在の設定・候補外）"));
        effort.ItemsSource = choices; effort.SelectedValue = selected ?? (choice is { Efforts.Length: 0 } ? "" : null);
        rendering = false; UpdateSave();
    }

    private BackgroundAgentSelection? Selected() => harness.SelectedValue is string h && model.SelectedValue is string m && effort.SelectedValue is string e ? new(h, m, e) : null;
    private void UpdateSave() => SaveButton.IsEnabled = Selected() is { } value && BackgroundAgentApi.IsAvailable(value, catalog);

    private async Task<bool> SaveAsync()
    {
        var selection = Selected();
        if (selection is null || !BackgroundAgentApi.IsAvailable(selection, catalog)) return false;
        try
        {
            await api.SaveAsync(initial!.Revision, selection, Token);
            initial = await api.ReadAsync(Token);
            Status.Text = "設定を保存しました。現在の設定: " + Describe(initial);
            return false;
        }
        catch (BellApiException error) when (error.Code == "BACKGROUND_AGENT_APPLY_FAILED")
        {
            initial = await api.ReadAsync(Token);
            Status.Text = "設定は保存しましたが、要約への反映を確認できません。現在の設定: " + Describe(initial);
            return false;
        }
        catch (BellApiException error) when (error.Code == "BACKGROUND_AGENT_REVISION_CONFLICT")
        {
            var latest = await api.ReadAsync(Token);
            Status.Text = "別の場所で設定が変更されました。現在の設定: " + Describe(latest) + "。入力を控えて画面を開き直してください。";
            return false;
        }
    }

    private void OnChanged() => Dispatcher.InvokeAsync(async () =>
    {
        try
        {
            var latest = await api.ReadAsync(Token);
            if (latest?.Revision != initial?.Revision) notice.Text = "別の場所で設定が変更されました。現在の設定: " + Describe(latest) + "。入力は保持しています。";
        }
        catch (OperationCanceledException) when (Token.IsCancellationRequested) { }
        catch (Exception error) { notice.Text = "最新の設定を確認できませんでした。\n" + error.Message; }
    });
    private static string Describe(BackgroundAgentState? state) => state?.Selection is { } value ? $"{value.Harness} / {value.Model} / {value.ReasoningEffort}" : "未設定";
}
