using Avalonia.Threading;
using BellTeam.Core;

namespace BellTeam.Linux;

// The render modes of the schedule, goal and request screens (Windows App.xaml.cs --render-schedules, --render-goals, --render-page, --render-conversation, --render-secret).
// Every scene reads from the server (GET only); states that need a write are set through render seams and never sent.
internal static class RequestsRender
{
    public const string Usage = "、--render-page <schedules|goals> <URL> <PNG>、--render-schedules <list|empty|failed|delete|editor-member|editor-room|editor-weekly-error|editor-interval> <URL> <PNG>"
        + "、--render-goals <pill|pill-open|editor-create|editor-edit> <URL> <会話ID> <PNG>、--render-conversation <secret|peer-sheet> <URL> <会話ID> <PNG>、--render-secret <シーン> <URL> <PNG>";

    public static bool IsKnown(string[] args) => args is ["--render-page", "schedules" or "goals", _, _] or ["--render-schedules", _, _, _] or ["--render-goals", _, _, _, _] or ["--render-conversation", "secret" or "peer-sheet", _, _, _] or ["--render-secret", _, _, _];

    // False when the arguments are not one of these modes.
    public static async Task<bool> TryRunAsync(string[] args)
    {
        switch (args)
        {
            case ["--render-page", var kind and ("schedules" or "goals"), var address, var output]: await PageAsync(kind, address, output); return true;
            case ["--render-schedules", var scene, var address, var output]: await SchedulesAsync(scene, address, output); return true;
            case ["--render-goals", var scene, var address, var botId, var output]: await GoalsAsync(scene, address, botId, output); return true;
            case ["--render-conversation", var scene and ("secret" or "peer-sheet"), var address, var id, var output]: await ConversationAsync(scene, address, id, output); return true;
            case ["--render-secret", var scene, var address, var output]: await SecretAsync(scene, address, output); return true;
            default: return false;
        }
    }

    private static async Task<(LinuxWorkspace Model, MainWindow Window)> OpenAsync(string address, string? conversationId = null)
    {
        var model = new LinuxWorkspace();
        var window = new MainWindow(model, persistPlacement: false) { AutoRetry = false };
        window.Show();
        await model.ConnectAsync(address, listen: false);
        if (model.ConnectionError is { } failure) throw new BellApiException(failure);
        if (conversationId is not null) await model.SelectAsync(model.Entries.FirstOrDefault(entry => entry.Target.Id == conversationId) ?? throw new BellApiException("指定した会話がありません。"));
        return (model, window);
    }

    private static async Task PageAsync(string kind, string address, string output)
    {
        var (model, window) = await OpenAsync(address);
        using (model)
        {
            if (kind == "schedules") window.ShowSchedules(); else window.ShowGoals();
            await window.PageReady;
            await window.PrepareRenderAsync(); Launcher.WritePng(window, output);
        }
    }

    private static async Task SchedulesAsync(string scene, string address, string output)
    {
        var (model, window) = await OpenAsync(address);
        using (model)
        {
            window.ShowSchedules(); await window.PageReady;
            var page = window.CurrentPage as SchedulesPage ?? throw new BellApiException("予定のページを開けませんでした。");
            ScheduleEditorView? editor = null;
            switch (scene)
            {
                case "list" or "empty" or "failed": break;
                case "delete": page.AskDeleteForRender(); break;
                case "editor-member": (editor = page.OpenEditorForRender()).Prefill(nameText: "朝の確認", text: "今日の予定と優先事項を整理して、先に知らせてほしい。"); break;
                case "editor-room": (editor = page.OpenEditorForRender()).Prefill(ownerPath: new ChatTarget("planning", true).Path, nameText: "週のふり返り", text: "進んだ仕事をまとめる", frequencyId: "daily"); break;
                case "editor-weekly-error": { editor = page.OpenEditorForRender("weekly"); editor.Prefill(frequencyId: "weekly", weekdays: []); await editor.SaveAsync(); break; }
                case "editor-interval": (editor = page.OpenEditorForRender()).Prefill(nameText: "巡回", text: "python3 tools/patrol.py", frequencyId: "interval_hours"); break;
                default: throw new ArgumentException("未対応の予定の画面です。");
            }
            await window.PageReady;
            await window.PrepareRenderAsync();
            if (scene == "editor-weekly-error") editor!.ScrollToEndForRender();
            Launcher.WritePng(window, output);
        }
    }

    private static async Task GoalsAsync(string scene, string address, string botId, string output)
    {
        var (model, window) = await OpenAsync(address, botId);
        using (model)
        {
            await window.GoalBar.LoadTask;
            if (scene == "pill-open") window.GoalBar.SetExpanded(true);
            if (scene is "editor-create" or "editor-edit")
            {
                var editor = window.GoalBar.OpenEditorForRender(scene == "editor-create" ? "create" : "edit") ?? throw new BellApiException("ゴールを読み取れませんでした。");
                if (scene == "editor-create") { editor.SetForRender("新機能の設計をまとめる", "abc"); await editor.SaveAsync(); }
            }
            else if (scene is not ("pill" or "pill-open")) throw new ArgumentException("未対応のゴールの画面です。");
            await window.PrepareRenderAsync(); Launcher.WritePng(window, output);
        }
    }

    private static async Task ConversationAsync(string scene, string address, string id, string output)
    {
        var (model, window) = await OpenAsync(address, id);
        using (model)
        {
            if (scene == "peer-sheet") window.ShowPeerSheet(model.Messages.Select(item => item.Message).First(item => item.Kind == "peer"));
            await window.PrepareRenderAsync(); Launcher.WritePng(window, output);
        }
    }

    // The secret input window for the first secret request of bot-one. Nothing is typed or sent.
    private static async Task SecretAsync(string scene, string address, string output)
    {
        var (model, main) = await OpenAsync(address, "bot-one");
        using (model)
        {
            var request = model.Messages.Select(item => item.Message.SecretRequest).FirstOrDefault(item => item is not null) ?? throw new BellApiException("秘密の依頼がありません。");
            var window = new SecretInputWindow(request, submission => model.FinishSecretAsync(request.Id, submission), () => model.SecretKeysAsync(request.Id), _ => { });
            window.Show();
            await window.KeysReady;
            if (scene.EndsWith("-search", StringComparison.Ordinal)) window.SearchForRender("infra"); else if (scene.EndsWith("-vault", StringComparison.Ordinal)) window.SearchForRender("team");
            Dispatcher.UIThread.RunJobs(); window.UpdateLayout();
            Launcher.WritePng(window, output);
            window.Close(); main.Close();
        }
    }
}
