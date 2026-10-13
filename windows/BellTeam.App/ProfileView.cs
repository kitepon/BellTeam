using System.ComponentModel;
using System.Windows;
using System.Windows.Controls;
using System.Windows.Media;
using BellTeam.Core;

namespace BellTeam.App;

public sealed class ProfileView : StackPanel
{
    public static readonly DependencyProperty WorkspaceProperty = DependencyProperty.Register(nameof(Workspace), typeof(Workspace), typeof(ProfileView), new PropertyMetadata(null, Changed));
    public Workspace? Workspace { get => (Workspace?)GetValue(WorkspaceProperty); set => SetValue(WorkspaceProperty, value); }
    private (ChatTarget? Target, string Profile, string? Avatar, string? Color, string Members)? rendered;
    public ProfileView() { Margin = new Thickness(23); }
    private static void Changed(DependencyObject target, DependencyPropertyChangedEventArgs args)
    {
        var view = (ProfileView)target;
        if (args.OldValue is Workspace old) old.PropertyChanged -= view.Updated;
        if (args.NewValue is Workspace next) next.PropertyChanged += view.Updated;
        view.Render();
    }
    private void Updated(object? sender, PropertyChangedEventArgs args) { if (args.PropertyName is nameof(BellTeam.App.Workspace.Selected) or nameof(BellTeam.App.Workspace.Profile)) Render(); }
    private void Render()
    {
        if (Workspace is not { } workspace) return;
        var entry = workspace.Selected;
        var content = (entry?.Target, workspace.Profile, entry?.AvatarUrl, entry?.Bot?.Color, string.Join(',', entry?.Room?.MemberIds ?? []));
        if (rendered == content) return;
        rendered = content; Children.Clear();
        if (entry is null) { AddText("メンバーやルームを選ぶと、ここに詳細を表示します。", 16, Brushes.Gray); return; }
        Children.Add(new AvatarTile { Entry = entry, Workspace = workspace, Width = 94, Height = 94, HorizontalAlignment = HorizontalAlignment.Center, Margin = new Thickness(0, 12, 0, 13) });
        AddText(entry.Name, 20, new SolidColorBrush(Color.FromRgb(33, 41, 61)), bold: true, centered: true);
        if (entry.Bot is { } bot)
        {
            if (bot.Position.Length != 0) AddText(bot.Position, 16, Brushes.SlateGray, centered: true);
            AddText(bot.Online ? "オンライン" : "次のメッセージで起動します", 14, bot.Online ? Brushes.MediumAquamarine : Brushes.SlateGray, centered: true);
        }
        Children.Add(new Border { Height = 1, Background = new SolidColorBrush(Color.FromRgb(229, 227, 240)), Margin = new Thickness(0, 20, 0, 20) });
        if (entry.Room is { } room)
        {
            Detail("この部屋で共有する仕事", room.Purpose); Heading("参加メンバー");
            foreach (var id in room.MemberIds)
            {
                var member = workspace.Conversations.FirstOrDefault(candidate => candidate.Target == new ChatTarget(id, false)); if (member is null) continue;
                var row = new StackPanel { Orientation = Orientation.Horizontal }; row.Children.Add(new AvatarTile { Entry = member, Workspace = workspace, Width = 30, Height = 30, Margin = new Thickness(0, 0, 10, 0) }); row.Children.Add(new TextBlock { Text = member.Name, FontSize = 16, VerticalAlignment = VerticalAlignment.Center });
                var button = new Button { Content = row, HorizontalContentAlignment = HorizontalAlignment.Left }; button.SetResourceReference(StyleProperty, "QuietButton"); button.Click += async (_, _) => await workspace.SelectAsync(member); Children.Add(button);
            }
        }
        else if (entry.Bot is { } member)
        {
            Heading("プロフィール"); Detail("役職", member.Position); Detail("背景・見た目・関係性", member.ProfileText); Detail("性格・考え方", member.Personality); Detail("口調", member.SpeechStyle); Detail("担当する仕事", member.Role);
            Heading("AI"); AddText("ハーネス　" + member.Harness, 14, Brushes.SlateGray); AddText("モデル　" + (member.Model.Length == 0 ? "既定" : member.Model), 14, Brushes.SlateGray);
            var screen = new Button { Content = "Botの画面を見る", HorizontalAlignment = HorizontalAlignment.Left, Margin = new Thickness(0, 15, 0, 6) }; screen.Click += async (_, _) => await workspace.OpenScreenAsync(); Children.Add(screen);
            var restart = new Button { Content = "会話セッションを再起動", HorizontalAlignment = HorizontalAlignment.Left };
            restart.Click += async (_, _) =>
            {
                restart.IsEnabled = false; var token = workspace.ConnectionToken; workspace.ReportActionError(null);
                try { await workspace.Management.RestartBotAsync(entry.Target.Id, token); await workspace.RefreshManagementAsync(); }
                catch (OperationCanceledException) when (token.IsCancellationRequested) { }
                catch (Exception error) { workspace.ReportActionError(error.Message); }
                finally { restart.IsEnabled = true; }
            }; Children.Add(restart);
        }
        var edit = new Button { Content = entry.Target.IsRoom ? "ルームを編集" : "メンバーを編集", Margin = new Thickness(0, 14, 0, 12), HorizontalAlignment = HorizontalAlignment.Left }; edit.SetResourceReference(StyleProperty, "PrimaryButton");
        edit.Click += (_, _) => { EditorWindow window = entry.Target.IsRoom ? new RoomEditor(workspace, entry.Target.Id) : new MemberEditor(workspace, entry.Target.Id); window.Owner = Window.GetWindow(this); if (window is RoomEditor roomEditor) _ = roomEditor.InitializeAsync(); else _ = ((MemberEditor)window).InitializeAsync(); window.ShowDialog(); }; Children.Add(edit);
    }
    private void Heading(string text) { var heading = new TextBlock { Text = text, FontSize = 14, FontWeight = FontWeights.Bold, Foreground = Brushes.SlateGray, Margin = new Thickness(0, 14, 0, 10) }; Children.Add(heading); }
    private void Detail(string title, string value)
    {
        Heading(title); var body = new TextBox { Text = value.Length == 0 ? "未設定" : value, Foreground = value.Length == 0 ? Brushes.SlateGray : new SolidColorBrush(Color.FromRgb(33, 41, 61)), Margin = new Thickness(0, 0, 0, 8) }; body.SetResourceReference(StyleProperty, "SelectableBody"); Children.Add(body);
        System.Windows.Automation.AutomationProperties.SetName(body, title);
    }
    private void AddText(string text, double size, Brush color, bool bold = false, bool centered = false) => Children.Add(new TextBlock { Text = text, FontSize = size, Foreground = color, FontWeight = bold ? FontWeights.SemiBold : FontWeights.Normal, TextWrapping = TextWrapping.Wrap, TextAlignment = centered ? TextAlignment.Center : TextAlignment.Left, Margin = new Thickness(0, 3, 0, 3) });
}
