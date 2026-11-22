using Avalonia;
using Avalonia.Controls;
using Avalonia.Layout;
using Avalonia.Media;
using Avalonia.Threading;
using BellTeam.Core;
using BellTeam.Linux;
using Kitepon.LoginBilling;
using Xamarin.Google.MLKit.Vision.Barcode.Common;
using Xamarin.Google.MLKit.Vision.CodeScanner;
using static BellTeam.Linux.SettingsUi;

namespace BellTeam.Android;

// a485 (contract 1.20): the phone that holds the contract lets another device in (the QR it shows, scanned, or the code typed), and lists and stops the devices it let in. Only a store pass has this (the library keeps the
// list on the store device only); a desktop is always the device that gets approved. The library asks the screen for the one answer (label and check number); the pass never reaches this code.
public sealed class ApprovePanel : StackPanel
{
    private readonly LoginBilling lb;
    private readonly CancellationToken token;
    private readonly TextBox code = FormKit.Field(StoreAccountText.ApproveCodeLabel, "");
    // Built once: a control has one parent, and Render() redraws the panel (a second Border around the same TextBox crashed the app, found on the emulator).
    private readonly Border codeBox;
    private bool busy;
    private string? result, failure;
    private (string Label, string Number, TaskCompletionSource<bool> Answer)? asking;

    public ApprovePanel(LoginBilling lb, CancellationToken token)
    {
        this.lb = lb; this.token = token; Spacing = 0;
        codeBox = new Border { Child = code, Background = Fill, CornerRadius = new CornerRadius(12), Padding = new Thickness(12, 4), Margin = new Thickness(0, 12, 0, 0) };
        Render();
    }

    private void Render()
    {
        Children.Clear();
        Children.Add(new Border { Height = 1, Background = Hairline, Margin = new Thickness(0, 16, 0, 4) });
        Children.Add(Text(StoreAccountText.ApproveTitle, 16, Ink, FontWeight.Bold, new Thickness(0, 8, 0, 0)));
        if (asking is { } ask) { RenderAsking(ask); return; }
        Children.Add(Text(StoreAccountText.ApproveLead, 13, Muted, null, new Thickness(0, 6, 0, 0)));
        Children.Add(Button(StoreAccountText.ApproveScan, ScanAsync, true));
        Children.Add(codeBox);
        Children.Add(Button(StoreAccountText.ApproveCodeGo, () => code.Text is { Length: > 0 } text ? ApproveAsync(text) : Task.CompletedTask, false));
        if (result is not null) Children.Add(Text(result, 14, Ink, FontWeight.SemiBold, new Thickness(0, 12, 0, 0)));
        if (failure is not null) Children.Add(Banner(failure));
        RenderLinked();
    }

    // The library's one question: whose login is this (label), and the number to compare with the other screen.
    private void RenderAsking((string Label, string Number, TaskCompletionSource<bool> Answer) ask)
    {
        Children.Add(Text(StoreAccountText.ApproveConfirmAsk, 14, Ink, FontWeight.SemiBold, new Thickness(0, 8, 0, 0)));
        Children.Add(Text(StoreAccountText.ApproveDevice(ask.Label), 14, Ink, null, new Thickness(0, 6, 0, 0)));
        Children.Add(Text(StoreAccountText.HandoffCheckNumber, 12, Muted, null, new Thickness(0, 10, 0, 0)));
        Children.Add(Text(ask.Number, 24, Ink, FontWeight.Bold));
        Children.Add(Text(StoreAccountText.ApproveCheckLine, 12, Muted, null, new Thickness(0, 4, 0, 0)));
        Children.Add(Text(StoreAccountText.ApproveOwnLine, 13, Muted, null, new Thickness(0, 6, 0, 0)));
        var row = new StackPanel { Orientation = Orientation.Horizontal, Spacing = 10 };
        row.Children.Add(Button(StoreAccountText.ApproveYes, () => { ask.Answer.TrySetResult(true); return Task.CompletedTask; }, true));
        row.Children.Add(Button(StoreAccountText.ApproveNo, () => { ask.Answer.TrySetResult(false); return Task.CompletedTask; }, false));
        Children.Add(row);
    }

    private void RenderLinked()
    {
        Children.Add(Text(StoreAccountText.LinkedTitle, 14, Ink, FontWeight.SemiBold, new Thickness(0, 18, 0, 0)));
        var devices = lb.LinkedDevices;
        if (devices.Count == 0) { Children.Add(Text(StoreAccountText.LinkedNone, 13, Muted, null, new Thickness(0, 6, 0, 0))); return; }
        foreach (var device in devices)
        {
            var row = new Grid { ColumnDefinitions = new ColumnDefinitions("*,Auto"), Margin = new Thickness(0, 8, 0, 0) };
            var name = Text(device.Label, 14, Ink); name.VerticalAlignment = VerticalAlignment.Center;
            var stop = Capsule(StoreAccountText.LinkedStop, Fill, Red, 12, 13, new Thickness(14, 8)); stop.IsEnabled = !busy;
            var passId = device.PassId; stop.Click += async (_, _) => await RunAsync(() => lb.StopAsync(passId));
            Grid.SetColumn(stop, 1); row.Children.Add(name); row.Children.Add(stop); Children.Add(row);
        }
    }

    // Google's code scanner (Play services) reads the QR without a camera permission of ours.
    private async Task ScanAsync()
    {
        string? raw = null;
        try
        {
            var options = new GmsBarcodeScannerOptions.Builder().SetBarcodeFormats(Barcode.FormatQrCode).Build();
            // Not AsAsync: the binding's listener passes a cancelled task's null Exception to SetException and kills the app when the person closes the scanner.
            var done = new TaskCompletionSource<string?>(TaskCreationOptions.RunContinuationsAsynchronously);
            var listener = new ScanListener(done);
            GmsBarcodeScanning.GetClient(MainActivity.Current, options).StartScan().AddOnSuccessListener(listener).AddOnFailureListener(listener).AddOnCanceledListener(listener);
            raw = await done.Task;
        }
        catch (Exception error) when (!token.IsCancellationRequested)
        {
            // The person closing the scanner is not a failure; anything else says so and offers the typed code.
            if (error.Message?.Contains("cancel", StringComparison.OrdinalIgnoreCase) != true) { failure = StoreAccountText.ApproveScanFailed; Render(); }
            return;
        }
        if (raw is { Length: > 0 }) await ApproveAsync(raw);
    }

    private sealed class ScanListener(TaskCompletionSource<string?> done) : Java.Lang.Object, global::Android.Gms.Tasks.IOnSuccessListener, global::Android.Gms.Tasks.IOnFailureListener, global::Android.Gms.Tasks.IOnCanceledListener
    {
        public void OnSuccess(Java.Lang.Object? result) => done.TrySetResult((result as Barcode)?.RawValue);
        public void OnFailure(Java.Lang.Exception error) => done.TrySetException(new InvalidOperationException(error.Message));
        public void OnCanceled() => done.TrySetResult(null);   // closing the scanner is not a failure
    }

    private Task<bool> Confirm(string label, string number)
    {
        var answer = new TaskCompletionSource<bool>(TaskCreationOptions.RunContinuationsAsynchronously);
        asking = (label, number, answer); Dispatcher.UIThread.Post(Render);
        return answer.Task;
    }

    private async Task ApproveAsync(string payload) => await RunAsync(async () =>
    {
        var approved = await lb.ApproveAsync(payload.Trim(), Confirm);
        result = approved.Outcome switch { ApproveOutcome.Approved => StoreAccountText.ApprovedLine, ApproveOutcome.Declined => StoreAccountText.DeclinedLine, _ => StoreAccountText.NotNeededLine };
        code.Text = "";
    });

    private async Task RunAsync(Func<Task> action)
    {
        if (busy) return;
        busy = true; failure = null; result = null; Render();
        try { await action(); }
        catch (LoginBillingException error) { failure = StoreAccountText.Failure(error.Code, error.Reason); }
        asking = null; busy = false;
        if (!token.IsCancellationRequested) Render();
    }

    private Button Button(string label, Func<Task> click, bool primary)
    {
        var button = Capsule(label, primary ? BellTheme.ProminentFill : Fill, primary ? Brushes.White : Ink, 12, 14, new Thickness(16, 10));
        button.FontWeight = primary ? FontWeight.SemiBold : FontWeight.Normal; button.HorizontalAlignment = HorizontalAlignment.Left; button.Margin = new Thickness(0, 12, 0, 0); button.IsEnabled = !busy || asking is not null;
        button.Click += async (_, _) => await click();
        return button;
    }
}
