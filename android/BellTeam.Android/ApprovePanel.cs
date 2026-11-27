using Avalonia;
using Avalonia.Controls;
using Avalonia.Input.Platform;
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
    private string? result, failure, pasted, returnLink, returnCause;   // returnLink/returnCause: 1.60 a code the LAN did not take, and why (1.61)
    private TaskCompletionSource<bool>? asking;

    public ApprovePanel(CancellationToken token)
    {
        this.token = token; Spacing = 0;
        Render();
    }
    // The phone's own camera opened this app with the QR's link (1.49): answer it as if the scanner had read it. The card keeps this panel across its re-renders, so it listens while attached.
    protected override void OnAttachedToVisualTree(Avalonia.VisualTreeAttachmentEventArgs e) { base.OnAttachedToVisualTree(e); JoinLink.Changed += TakeLink; TakeLink(); }
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
        // 1.60: the wanting device's code, pasted, goes the way a scanned text goes.
        var paste = new TextBox { Text = pasted, Watermark = LocalFormText.PasteLabel, FontSize = 14, Margin = new Thickness(0, 14, 0, 0) };
        Avalonia.Automation.AutomationProperties.SetName(paste, LocalFormText.PasteLabel);
        paste.TextChanged += (_, _) => pasted = paste.Text;
        Children.Add(paste);
        Children.Add(Button(LocalFormText.PasteUse, UsePastedAsync, false));
        if (returnLink is { } back) RenderReturn(back);
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

    private async Task UsePastedAsync()
    {
        if (pasted?.Trim() is not { Length: > 0 } text) return;
        if (LbLocalForm.IsLibraryQR(text)) await ApproveAsync(text); else { failure = StoreAccountText.ApproveScanFailed; Render(); }
    }

    // 1.60: the LAN did not take this phone's answer; the join code's return link goes back to the wanting device, opened (same phone) or copied (another), with the cause's words (1.61) when there is one.
    private void RenderReturn(string link)
    {
        Children.Add(Text(LocalFormText.ReturnLead, 14, Ink, FontWeight.SemiBold, new Thickness(0, 12, 0, 0)));
        if (LocalWords.Ja(returnCause) is { } words) Children.Add(Text(words, 13, Muted, null, new Thickness(0, 6, 0, 0)));
        var row = new StackPanel { Orientation = Orientation.Horizontal, Spacing = 10 };
        row.Children.Add(Button(LocalFormText.ReturnOpen, () => { MainActivity.Current.StartActivity(new global::Android.Content.Intent(global::Android.Content.Intent.ActionView, global::Android.Net.Uri.Parse(link))); return Task.CompletedTask; }, true));
        row.Children.Add(Button(LocalFormText.ReturnCopy, async () => { if (TopLevel.GetTopLevel(this)?.Clipboard is { } board) await board.SetTextAsync(link); }, false));
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
        // login-billing 1.53 (11.12): every scanned text goes to IsLibraryQR first; the app never matches the library's QR forms itself.
        if (raw?.Trim() is { Length: > 0 } text) { if (LbLocalForm.IsLibraryQR(text)) await ApproveAsync(text); else { failure = StoreAccountText.ApproveScanFailed; Render(); } }
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
        returnLink = returnCause = null;
        LocalAnswerResult answered;
        try { answered = await local.AnswerAsync(MainActivity.Current, qr, Confirm); }
        catch (LoginBillingException error) when (error.Code == "signin_required")
        {
            await local.SignInLocalAsync(MainActivity.Current);
            answered = await local.AnswerAsync(MainActivity.Current, qr, Confirm);
        }
        if (answered.Answered == LocalAnswered.ReturnLink) { returnLink = answered.ReturnLink; returnCause = answered.Cause; return; }
        result = answered.Answered switch { LocalAnswered.Taken => StoreAccountText.ApprovedLine, LocalAnswered.NoPurchase => StoreAccountText.ApproveNoPurchase, _ => StoreAccountText.DeclinedLine };
    });

    private async Task RunAsync(Func<LbLocalForm, Task> action)
    {
        if (busy || AccountStore.Local is not { } local) return;
        busy = true; failure = null; result = null; Render();
        try { await action(local); }
        catch (LoginBillingException error) when (error.Code == "signin_cancelled") { }   // the person's own choice says nothing
        catch (LoginBillingException error) { failure = LocalWords.Ja(error.Code) ?? LocalFormText.Failure(error.Code, error.Reason, error.Detail); }
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
