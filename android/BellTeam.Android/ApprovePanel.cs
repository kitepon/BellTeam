using Avalonia;
using Avalonia.Controls;
using Avalonia.Layout;
using Avalonia.Media;
using Avalonia.Threading;
using BellTeam.Core;
using BellTeam.Linux;
using Kitepon.LoginBilling;
using LbLocalForm = Kitepon.LoginBilling.LocalForm;   // BellTeam.Core also has a LocalForm (the period rule)
using Xamarin.Google.MLKit.Vision.Barcode.Common;
using Xamarin.Google.MLKit.Vision.CodeScanner;
using static BellTeam.Linux.SettingsUi;

namespace BellTeam.Android;

// a540 (login-billing contract 1.36 section 10): the phone that holds the purchase lets another device in. It reads the QR that device shows, checks that the device wants this phone's own account, asks the person once, and sends this phone's
// own Play purchase straight to that device over the same network (LAN). No server takes part; the library keeps the proof and the token, this code sees neither.
public sealed class ApprovePanel : StackPanel
{
    private readonly CancellationToken token;
    private bool busy;
    private string? result, failure;
    private TaskCompletionSource<bool>? asking;

    public ApprovePanel(CancellationToken token)
    {
        this.token = token; Spacing = 0;
        Render();
        // The phone's own camera opened this app with the QR's link (1.49): answer it as if the scanner had read it.
        JoinLink.Changed += TakeLink;
        TakeLink();
    }
    protected override void OnDetachedFromVisualTree(Avalonia.VisualTreeAttachmentEventArgs e) { JoinLink.Changed -= TakeLink; base.OnDetachedFromVisualTree(e); }
    private void TakeLink() => Dispatcher.UIThread.Post(() => { if (!busy && JoinLink.Take() is { } link) _ = ApproveAsync(link); });

    private void Render()
    {
        Children.Clear();
        Children.Add(new Border { Height = 1, Background = Hairline, Margin = new Thickness(0, 16, 0, 4) });
        Children.Add(Text(StoreAccountText.ApproveTitle, 16, Ink, FontWeight.Bold, new Thickness(0, 8, 0, 0)));
        if (asking is { } answer) { RenderAsking(answer); return; }
        Children.Add(Text(LocalFormText.ApproveLead, 13, Muted, null, new Thickness(0, 6, 0, 0)));
        Children.Add(Button(StoreAccountText.ApproveScan, ScanAsync, true));
        if (result is not null) Children.Add(Text(result, 14, Ink, FontWeight.SemiBold, new Thickness(0, 12, 0, 0)));
        if (failure is not null) Children.Add(Banner(failure));
    }

    // The one question: is this login yours? Only a login the person started themselves may be allowed.
    private void RenderAsking(TaskCompletionSource<bool> answer)
    {
        Children.Add(Text(StoreAccountText.ApproveConfirmAsk, 14, Ink, FontWeight.SemiBold, new Thickness(0, 8, 0, 0)));
        Children.Add(Text(StoreAccountText.ApproveOwnLine, 13, Muted, null, new Thickness(0, 6, 0, 0)));
        var row = new StackPanel { Orientation = Orientation.Horizontal, Spacing = 10 };
        row.Children.Add(Button(StoreAccountText.ApproveYes, () => { answer.TrySetResult(true); return Task.CompletedTask; }, true));
        row.Children.Add(Button(StoreAccountText.ApproveNo, () => { answer.TrySetResult(false); return Task.CompletedTask; }, false));
        Children.Add(row);
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
            // The person closing the scanner is not a failure; anything else says so.
            if (error.Message?.Contains("cancel", StringComparison.OrdinalIgnoreCase) != true) { failure = StoreAccountText.ApproveScanFailed; Render(); }
            return;
        }
        if (raw is { Length: > 0 }) await ApproveAsync(raw.Trim());
    }

    private sealed class ScanListener(TaskCompletionSource<string?> done) : Java.Lang.Object, global::Android.Gms.Tasks.IOnSuccessListener, global::Android.Gms.Tasks.IOnFailureListener, global::Android.Gms.Tasks.IOnCanceledListener
    {
        public void OnSuccess(Java.Lang.Object? result) => done.TrySetResult((result as Barcode)?.RawValue);
        public void OnFailure(Java.Lang.Exception error) => done.TrySetException(new InvalidOperationException(error.Message));
        public void OnCanceled() => done.TrySetResult(null);   // closing the scanner is not a failure
    }

    private Task<bool> Confirm()
    {
        var answer = new TaskCompletionSource<bool>(TaskCreationOptions.RunContinuationsAsynchronously);
        asking = answer; Dispatcher.UIThread.Post(Render);
        return answer.Task;
    }

    // signin_required: this phone has not signed in with Google yet (the token that proves it is the same account is made then); sign in once and answer again.
    private async Task ApproveAsync(string qr) => await RunAsync(async local =>
    {
        LocalAnswered answered;
        try { answered = await local.AnswerAsync(MainActivity.Current, qr, Confirm); }
        catch (LoginBillingException error) when (error.Code == "signin_required")
        {
            await local.SignInLocalAsync(MainActivity.Current);
            answered = await local.AnswerAsync(MainActivity.Current, qr, Confirm);
        }
        result = answered switch { LocalAnswered.Taken => StoreAccountText.ApprovedLine, LocalAnswered.NoPurchase => StoreAccountText.ApproveNoPurchase, _ => StoreAccountText.DeclinedLine };
    });

    private async Task RunAsync(Func<LbLocalForm, Task> action)
    {
        if (busy || AccountStore.Local is not { } local) return;
        busy = true; failure = null; result = null; Render();
        try { await action(local); }
        catch (LoginBillingException error) when (error.Code == "signin_cancelled") { }   // the person's own choice says nothing
        catch (LoginBillingException error) { failure = LocalFormText.Failure(error.Code, error.Reason, error.Detail); }
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
