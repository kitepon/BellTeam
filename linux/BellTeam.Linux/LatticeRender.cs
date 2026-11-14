using Avalonia.Threading;
using BellTeam.Core;

namespace BellTeam.Linux;

// The render modes of the two separate windows (windows/BellTeam.App/App.xaml.cs --render-lattice and --render-workgraph): the real reads and drawing in a headless window.
internal static class LatticeRender
{
    public static readonly string[] Scenes = ["list", "list-back", "list-empty", "old-server", "single", "chart", "authored", "tree", "tree-detail", "history", "owner", "owner-lanes", "detail", "highlight", "unverified", "last-verified", "unknown", "degraded", "reconnecting", "unavailable", "not-found", "narrow", "waits-open"];

    private static async Task Until(Func<bool> done, string what)
    {
        var until = DateTime.UtcNow.AddSeconds(10);
        while (!done()) { if (DateTime.UtcNow > until) throw new BellApiException(what); await Task.Delay(20); }
    }

    // The 工程表 window over the in-process fixture (LatticeFixture): the real API reads, SSE and drawing. Particles are drawn at a fixed clock.
    public static async Task LatticeAsync(string scene, string output)
    {
        if (!Scenes.Contains(scene)) throw new ArgumentException("未対応の工程表の場面です。" + Launcher.Usage);
        using var model = new LinuxWorkspace(origin => new BellApi(origin, new LatticeFixture(scene)));
        await model.ConnectAsync("http://localhost", listen: false);
        if (model.ConnectionError is { } failure) throw new BellApiException(failure);
        var lattice = new LatticeWindow(model, _ => Task.CompletedTask) { Clock = () => 2300 };
        LatticeChartPage.View = scene switch { "tree" or "tree-detail" or "owner" => "tree", "history" => "history", _ => "lanes" };
        // 待ちの流れ starts closed; the scenes that read its rows open it. 「narrow」 is the window at its minimum width.
        LatticeChartPage.WaitsOpen = scene is "unknown" or "owner-lanes" or "waits-open";
        if (scene == "narrow") lattice.Width = lattice.MinWidth;
        lattice.Show();
        lattice.Sync();
        if (scene is "list" or "list-empty" or "old-server") await Until(() => lattice.ListSettled, "工程表の一覧を読めませんでした。");
        else if (scene == "list-back")
        {
            // 一覧 opened from a chart through the switcher: the back button names that chart.
            lattice.OpenChart("lattice"); await Until(() => lattice.Chart!.Feed.Snapshot is not null, "工程表のsnapshotを受け取れませんでした。");
            lattice.ShowList(fromChart: true); await Until(() => lattice.ListSettled, "工程表の一覧を読めませんでした。");
        }
        else
        {
            lattice.OpenChart(scene == "not-found" ? "missing" : "lattice");
            var chart = lattice.Chart!;
            await Until(() => scene switch { "not-found" => chart.Feed.Connection == LatticeConnection.NotFound, "reconnecting" => chart.Feed.Connection == LatticeConnection.Reconnecting, _ => chart.Feed.Snapshot is not null }, "工程表のsnapshotを受け取れませんでした。");
            Dispatcher.UIThread.RunJobs(); lattice.UpdateLayout();
            if (scene is "detail" or "tree-detail") chart.OpenDetail("p1/t04", morph: false);
            if (scene == "owner") chart.OpenDetail("p1/t11", morph: false);
            if (scene == "owner-lanes") { chart.ScrollBoard(chart.Board.CardRect("p1/t09")!.Value.X, chart.Board.CardRect("p1/t11")!.Value.Y - 120); chart.ScrollWaitsToEnd(); }
            if (scene == "highlight") chart.Highlight("bot-flora");
            if (scene == "unknown") chart.ScrollWaitsToEnd();
            if (scene == "authored") chart.ScrollBoard(chart.Board.CardRect("p1/t07")!.Value.X, chart.Board.CardRect("p1/t09")!.Value.Y);
        }
        Dispatcher.UIThread.RunJobs(); lattice.UpdateLayout();
        Launcher.WritePng(lattice, output);
        lattice.Chart?.Stop(); lattice.Close();
    }

    // The work graph read from a server (GET only): the real stream and model, with a virtual clock so 12 s of simulation is stepped at 60 Hz without waiting.
    public static async Task WorkGraphAsync(string address, string output)
    {
        using var model = new LinuxWorkspace();
        await model.ConnectAsync(address, listen: false);
        if (model.ConnectionError is { } failure) throw new BellApiException(failure);
        var now = 0.0;
        var window = new WorkGraphWindow(model, _ => Task.CompletedTask, () => now) { Width = 960, Height = 640 };
        window.Show();
        Dispatcher.UIThread.RunJobs(); window.UpdateLayout();
        window.Sync();
        await Until(() => window.Graph.Model.Connection == WorkGraphConnection.Live, "相関図のsnapshotを受け取れませんでした。");
        for (var frame = 0; frame < 12 * 60; frame++) { now += 1.0 / 60; window.Graph.Frame(now); }
        window.Graph.Stop();
        Dispatcher.UIThread.RunJobs(); window.UpdateLayout();
        Launcher.WritePng(window, output);
        window.Close();
    }
}
