using System.Windows;
using System.Windows.Controls;
using System.Windows.Media;
using BellTeam.Core;
using static BellTeam.App.SettingsUi;

namespace BellTeam.App;

// 設定「稼働中に数えない処理」 (a65): the approved entries with the Owner's 外す, and the proposals that wait for his Approval Box answer.
// Read on open, after a 外す, and again with backoff after a failed read while the page is open (読み直す reads at once).
public sealed partial class SettingsWindow
{
    private RunningExclusionList? exclusions;
    private bool exclusionsUnreadable;
    internal RunningExclusionList? Exclusions => exclusions;

    private async Task LoadExclusionsAsync()
    {
        try { exclusions = await workspace.Management.Api.ListAsync(Token); exclusionsUnreadable = false; }
        catch (OperationCanceledException) when (Token.IsCancellationRequested) { throw; }
        catch (Exception error) { exclusionsUnreadable = RunningExclusions.Failure(error) != RunningExclusionsRead.OldServer && exclusions is null; }
    }
    private string? MemberName(string botId) => workspace.Bots.FirstOrDefault(bot => bot.Id == botId) is { } bot ? bot.DisplayName is { Length: > 0 } shown ? shown : bot.Name : null;

    private async Task ExclusionsPageAsync(CancellationToken token)
    {
        var page = NewPage(SettingsPage.Exclusions); var area = new StackPanel(); page.Children.Add(area);
        page.Children.Insert(1, Text(RunningExclusions.Explain, 13, Secondary, null, new Thickness(4, 4, 4, 10)));
        RunningExclusionsRead? failure = null; string? readError = null, note = null; bool reading = false, again = false; var attempt = 0; string? removing = null;
        CancellationTokenSource? wait = null;
        void Render()
        {
            area.Children.Clear();
            if (note is not null) area.Children.Add(Banner(note));
            if (exclusions is null)
            {
                if (reading || failure is null && readError is null) { area.Children.Add(Loading("読み込んでいます…")); return; }
                if (failure == RunningExclusionsRead.OldServer) { area.Children.Add(Text(RunningExclusions.OldServer, 14, Secondary, null, new Thickness(4, 6, 0, 0))); return; }
            }
            if (readError is not null)
            {
                var retry = Capsule("読み直す", Brushes.Transparent, Violet, 8, 13, new Thickness(0, 4, 0, 4)); retry.HorizontalAlignment = HorizontalAlignment.Left; retry.Click += (_, _) => _ = ReadAsync();
                var failed = new StackPanel(); failed.Children.Add(Banner((exclusions is null ? "一覧を読み込めませんでした。" : "最新の一覧を読み込めませんでした。前に読んだ一覧を表示しています。") + "自動で読み直します。"));
                failed.Children.Add(Text(readError, 12, Secondary, null, new Thickness(0, 4, 0, 4))); failed.Children.Add(retry); area.Children.Add(failed);
            }
            if (exclusions is not { } list) return;
            var entries = RunningExclusions.Entries(list, MemberName); var pending = RunningExclusions.Pending(list, MemberName);
            if (entries.Count == 0 && pending.Count == 0) { area.Children.Add(FormSection(null, new GroupCard(Row(Text(RunningExclusions.Empty, 14, Secondary))))); return; }
            if (entries.Count > 0) { var group = new GroupCard(); foreach (var row in entries) group.Add(Row(ExclusionRow(row, removing, id => _ = RemoveAsync(id, row.Summary)))); area.Children.Add(FormSection("数えない処理", group)); }
            if (pending.Count > 0) { var group = new GroupCard(); foreach (var row in pending) group.Add(Row(ExclusionRow(row, null, null))); area.Children.Add(FormSection("承認を待っている提案", group, "承認箱で答えると一覧に反映します。")); }
        }
        // One read at a time: a read asked for while one runs is done once more after it; a waiting retry is cut short.
        async Task ReadAsync()
        {
            if (reading) { again = true; return; }
            wait?.Cancel();
            do
            {
                reading = true; again = false; Render();
                try { exclusions = await workspace.Management.Api.ListAsync(token); exclusionsUnreadable = false; failure = null; readError = null; attempt = 0; }
                catch (OperationCanceledException) when (token.IsCancellationRequested) { return; }
                catch (Exception error)
                {
                    failure = RunningExclusions.Failure(error);
                    readError = failure == RunningExclusionsRead.OldServer ? null : error.Message; exclusionsUnreadable = readError is not null && exclusions is null;
                }
                reading = false; RefreshRows(); Render();
            } while (again);
            if (readError is not null) _ = RetryAsync();
        }
        // A failed read waits 1, 2, 4 … 30 s and tries again while the page is open; the page itself is ready after the first answer.
        async Task RetryAsync()
        {
            var pause = wait = CancellationTokenSource.CreateLinkedTokenSource(token);
            try { await Task.Delay(LatticeChart.BackoffMs(attempt++), pause.Token); } catch (OperationCanceledException) { return; }
            await ReadAsync();
        }
        async Task RemoveAsync(string id, string summary)
        {
            if (removing is not null) return;
            if (new ConfirmationWindow("稼働中に数えない処理", $"「{summary}」を一覧から外しますか？ 外すと、この処理が動いている席は仕事中に数えます。", "外す") { Owner = DialogOwner }.ShowDialog() != true) return;
            removing = id; note = null; Render();
            // Sent once; whatever the answer, the list is read again to show what the server holds.
            try { await workspace.Management.Api.RemoveAsync(id, token); }
            catch (OperationCanceledException) when (token.IsCancellationRequested) { return; }
            catch (Exception error) { note = RunningExclusions.RemoveFailure(error); }
            removing = null; await ReadAsync();
        }
        await ReadAsync();
    }

    private static UIElement ExclusionRow(RunningExclusionRow row, string? removing, Action<string>? remove)
    {
        var grid = new Grid(); grid.ColumnDefinitions.Add(new ColumnDefinition { Width = new GridLength(30) }); grid.ColumnDefinitions.Add(new ColumnDefinition()); grid.ColumnDefinitions.Add(new ColumnDefinition { Width = GridLength.Auto });
        // An AI child seat wears the AI mark; a process the command prompt.
        var tile = Tile(row.Child ? "✦" : "", row.Child ? Color.FromRgb(0xAF, 0x52, 0xDE) : Color.FromRgb(0x8E, 0x8E, 0x93), 30, row.Child); tile.VerticalAlignment = VerticalAlignment.Top; grid.Children.Add(tile);
        var text = new StackPanel { Margin = new Thickness(12, 0, 8, 0) };
        text.Children.Add(Text(row.Summary, 14, Ink, FontWeights.SemiBold));
        if (row.Scope.Length > 0) text.Children.Add(Text($"対象 {row.Scope}", 12, Secondary, null, new Thickness(0, 2, 0, 0)));
        text.Children.Add(Text(row.When, 12, Secondary, null, new Thickness(0, 2, 0, 0)));
        if (row.Reason is { } reason) text.Children.Add(Text(reason, 12.5, Muted, null, new Thickness(0, 4, 0, 0)));
        Grid.SetColumn(text, 1); grid.Children.Add(text);
        if (row.Id is { } id && remove is not null)
        {
            var button = Capsule(removing == id ? "外しています…" : "外す", Brushes.Transparent, Red, 8, 13, new Thickness(10, 4, 10, 4)); button.IsEnabled = removing is null; button.VerticalAlignment = VerticalAlignment.Center;
            System.Windows.Automation.AutomationProperties.SetName(button, $"外す、{row.Summary}"); System.Windows.Automation.AutomationProperties.SetAutomationId(button, "exclusion-remove");
            button.Click += (_, _) => remove(id); Grid.SetColumn(button, 2); grid.Children.Add(button);
        }
        System.Windows.Automation.AutomationProperties.SetName(grid, row.Label);
        return grid;
    }
}
