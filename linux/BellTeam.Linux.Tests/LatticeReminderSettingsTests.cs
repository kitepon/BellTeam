using System.Net;
using System.Net.Http.Json;
using System.Text.Json;
using Avalonia;
using Avalonia.Automation;
using Avalonia.Controls;
using Avalonia.Headless;
using Avalonia.Input;
using Avalonia.Input.Raw;
using Avalonia.VisualTree;
using BellTeam.Core;

namespace BellTeam.Linux;

public sealed class LatticeReminderSettingsTests
{
    [Fact]
    public Task ChartToolbarOpensSettingsAndSavesTheSwitch() => Ui.Run(async () =>
    {
        var server = new ReminderServer { SaveGate = new() };
        using var workspace = new LinuxWorkspace(origin => new BellApi(origin, server));
        var window = await OpenChartAsync(workspace);
        var originalView = LatticeChartPage.View;
        try
        {
            foreach (var view in new[] { "tree", "lanes", "history" })
            {
                Click(window, Find<Button>(window, "lattice-view-" + view));
                var gear = Find<Button>(window, "lattice-chart-settings");
                Assert.Equal("工程表の設定", AutomationProperties.GetName(gear));
                Click(window, gear);
                var reminder = Find<IosSwitch>(window, "lattice-reminder-switch");
                await UntilAsync(() => reminder.IsEnabled);
                Assert.Equal("1分ごとの催促", AutomationProperties.GetName(reminder));
                Assert.Contains(window.GetVisualDescendants().OfType<TextBlock>(), text => text.Text == "Lattice組込" && text.IsEffectivelyVisible);
                Assert.False(reminder.IsChecked);
                Click(window, LabeledButton(window, "閉じる"));
                Assert.Equal(view, LatticeChartPage.View);
            }

            Click(window, Find<Button>(window, "lattice-chart-settings"));
            var toggle = Find<IosSwitch>(window, "lattice-reminder-switch");
            await UntilAsync(() => toggle.IsEnabled);
            Click(window, toggle);
            Assert.False(toggle.IsEnabled);
            Assert.False(toggle.IsChecked);
            Assert.Equal("設定を保存しています。", Find<TextBlock>(window, "lattice-reminder-status").Text);
            server.SaveGate.SetResult();
            await UntilAsync(() => toggle.IsEnabled && toggle.IsChecked == true);
            Assert.True(server.Enabled);
            Assert.Equal(new[] { "{\"enabled\":true}" }, server.Writes);
            Click(window, LabeledButton(window, "閉じる"));
            Click(window, Find<Button>(window, "lattice-chart-settings"));
            toggle = Find<IosSwitch>(window, "lattice-reminder-switch");
            await UntilAsync(() => toggle.IsEnabled);
            Assert.True(toggle.IsChecked);
            Click(window, toggle);
            await UntilAsync(() => toggle.IsEnabled && toggle.IsChecked == false);
            Assert.False(server.Enabled);
            Assert.Equal(new[] { "{\"enabled\":true}", "{\"enabled\":false}" }, server.Writes);
        }
        finally { LatticeChartPage.View = originalView; window.Close(); }
    });

    [Fact]
    public Task FailedSaveReadsBackWithoutResendingTheWrite() => Ui.Run(async () =>
    {
        var server = new ReminderServer { FailSave = true };
        using var workspace = new LinuxWorkspace(origin => new BellApi(origin, server));
        var window = await OpenChartAsync(workspace);
        try
        {
            Click(window, Find<Button>(window, "lattice-chart-settings"));
            var toggle = Find<IosSwitch>(window, "lattice-reminder-switch");
            await UntilAsync(() => toggle.IsEnabled);
            server.FailRead = true;
            Click(window, toggle);
            var retry = LabeledButton(window, "読み直す");
            await UntilAsync(() => retry.IsEffectivelyVisible);
            Assert.False(toggle.IsChecked);
            Assert.False(toggle.IsEnabled);
            Assert.True(server.Enabled);
            server.FailRead = false;
            Click(window, retry);
            await UntilAsync(() => toggle.IsEnabled && toggle.IsChecked == true);
            Assert.Contains(window.GetVisualDescendants().OfType<TextBlock>(), text => text.Text == "設定を保存できませんでした。" && text.IsEffectivelyVisible);
            Assert.Single(server.Writes);
            Assert.True(server.Reads >= 3);
        }
        finally { window.Close(); }
    });

    [Theory]
    [InlineData("NOT_FOUND", "このサーバーでは催促の設定を変更できません。")]
    [InlineData("LATTICE_CHART_NOT_FOUND", "この工程表は見つかりません。")]
    public Task MissingRouteAndMissingChartHaveDifferentActions(string error, string message) => Ui.Run(async () =>
    {
        var server = new ReminderServer { NotFound = error };
        using var workspace = new LinuxWorkspace(origin => new BellApi(origin, server));
        var window = await OpenChartAsync(workspace);
        try
        {
            Click(window, Find<Button>(window, "lattice-chart-settings"));
            var status = Find<TextBlock>(window, "lattice-reminder-status");
            await UntilAsync(() => status.Text == message);
            Assert.False(Find<IosSwitch>(window, "lattice-reminder-switch").IsEnabled);
            var missing = error == "LATTICE_CHART_NOT_FOUND";
            Click(window, LabeledButton(window, missing ? "一覧へ戻る" : "閉じる"));
            Assert.Equal(missing, window.Chart is null);
            Assert.Empty(server.Writes);
        }
        finally { window.Close(); }
    });

    private static async Task<LatticeWindow> OpenChartAsync(LinuxWorkspace workspace)
    {
        await workspace.ConnectAsync("http://localhost", listen: false);
        var window = new LatticeWindow(workspace, _ => Task.CompletedTask);
        window.Show();
        await UntilAsync(() => window.ListSettled);
        var chart = window.GetVisualDescendants().OfType<Button>().First(button => AutomationProperties.GetAutomationId(button) == "lattice-chart-card");
        Click(window, chart);
        await UntilAsync(() => window.Chart?.Feed.Snapshot is not null);
        return window;
    }

    private static T Find<T>(Window window, string id) where T : Control =>
        window.GetVisualDescendants().OfType<T>().Single(element => AutomationProperties.GetAutomationId(element) == id);

    private static Button LabeledButton(Window window, string label) =>
        window.GetVisualDescendants().OfType<Button>().Single(button => AutomationProperties.GetName(button) == label);

    private static void Click(Window window, Control control)
    {
        window.UpdateLayout();
        var location = control.TranslatePoint(new Point(control.Bounds.Width / 2, control.Bounds.Height / 2), window);
        Assert.True(control.IsEffectivelyVisible && control.IsEffectivelyEnabled && location.HasValue);
        window.MouseDown(location!.Value, MouseButton.Left, RawInputModifiers.None);
        window.MouseUp(location.Value, MouseButton.Left, RawInputModifiers.None);
    }

    private static async Task UntilAsync(Func<bool> condition)
    {
        for (var attempt = 0; attempt < 100 && !condition(); attempt++) await Task.Delay(20);
        Assert.True(condition());
    }

    private sealed class ReminderServer : HttpMessageHandler
    {
        private readonly HttpMessageInvoker chart = new(new LatticeFixture("list"));
        public bool Enabled { get; private set; }
        public List<string> Writes { get; } = [];
        public int Reads { get; private set; }
        public TaskCompletionSource? SaveGate { get; init; }
        public bool FailSave { get; init; }
        public bool FailRead { get; set; }
        public string? NotFound { get; init; }

        protected override async Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken token)
        {
            if (request.RequestUri?.AbsolutePath != "/api/lattice/charts/lattice/reminders") return await chart.SendAsync(request, token);
            if (request.Method == HttpMethod.Put)
            {
                var body = await request.Content!.ReadAsStringAsync(token);
                Writes.Add(body);
                if (SaveGate is not null) await SaveGate.Task.WaitAsync(token);
                Enabled = JsonSerializer.Deserialize<JsonElement>(body).GetProperty("enabled").GetBoolean();
                if (FailSave) return new(HttpStatusCode.ServiceUnavailable);
            }
            else
            {
                Reads++;
                if (NotFound is { } error) return new(HttpStatusCode.NotFound) { Content = JsonContent.Create(new { error }) };
                if (FailRead) return new(HttpStatusCode.ServiceUnavailable);
            }
            return new(HttpStatusCode.OK) { Content = JsonContent.Create(new { schema = "bellteam.lattice-reminders.v1", projectId = "lattice", enabled = Enabled }) };
        }

        protected override void Dispose(bool disposing)
        {
            if (disposing) chart.Dispose();
            base.Dispose(disposing);
        }
    }
}
