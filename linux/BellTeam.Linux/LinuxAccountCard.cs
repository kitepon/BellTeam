using Avalonia;
using Avalonia.Controls;
using Avalonia.Layout;
using Avalonia.Media;
using BellTeam.Core;
using Kitepon.LoginBilling.Desktop;
using static BellTeam.Linux.SettingsUi;

namespace BellTeam.Linux;

// a485 (login-billing contract 1.20): the account of this PC, laid out like the Android card (icon tile, title and one badge; the state sentence; the actions). A desktop never buys: it signs in through the
// system browser, and a device with no contract shows the handoff QR for a phone that has one (7f). The pass never reaches this code. No e-mail or name exists anywhere.
public sealed class LinuxAccountCard : StackPanel
{
    private readonly CancellationToken token;
    private DesktopLoginBilling? billing => LinuxAccountStore.Billing;
    private string? failure;
    private bool busy, handoffAsked, handoffCancelled, confirmingStop;
    private bool? serverEntitled;   // CheckAsync's answer (the stored entitlements are empty after a restart)
    private IReadOnlyList<Entitlement>? checkedEntitlements;
    private LoginStart? handoff;
    private CancellationTokenSource? webSignIn, handoffWait;
    private int epoch;

    // The account gate (first run) waits for this: true once the pass has a contract.
    public bool Entitled { get; private set; }
    public event Action? EntitledChanged;

    public LinuxAccountCard(CancellationToken token)
    {
        this.token = token; Spacing = 0;
        Render();
        _ = LoadAsync();
        LinuxAccountStore.Foreground += OnForeground; token.Register(() => LinuxAccountStore.Foreground -= OnForeground);
    }

    private void OnForeground() => Avalonia.Threading.Dispatcher.UIThread.Post(() => _ = ReloadAsync());

    // Foreground: show what the server says now; when the state changed by itself the last action's line no longer fits it, so it goes.
    private async Task ReloadAsync()
    {
        if (token.IsCancellationRequested || busy) return;
        var before = (billing?.PassKind, serverEntitled);
        string? fresh = null;
        if (billing is { PassKind: not PassKind.None } lb)
        {
            try { var check = await lb.CheckAsync(token); serverEntitled = check.Entitlements.Count != 0; checkedEntitlements = check.Entitlements; }
            catch (OperationCanceledException) when (token.IsCancellationRequested) { return; }
            catch (LoginBillingException error) { fresh = StoreAccountText.Failure(error.Code, error.Status); }
        }
        else serverEntitled = null;
        if (token.IsCancellationRequested) return;
        failure = fresh ?? ((billing?.PassKind, serverEntitled) != before ? null : failure);
        Render();
    }

    private async Task LoadAsync()
    {
        if (billing is { PassKind: not PassKind.None } signedIn)
        {
            try { var check = await signedIn.CheckAsync(token); serverEntitled = check.Entitlements.Count != 0; checkedEntitlements = check.Entitlements; }
            catch (OperationCanceledException) when (token.IsCancellationRequested) { return; }
            catch (LoginBillingException error) { failure = StoreAccountText.Failure(error.Code, error.Status); }
            if (!token.IsCancellationRequested) Render();
        }
        if (billing is { PassKind: PassKind.Signed }) await HandoffAsync(billing); else handoffAsked = false;
    }

    // Contract 1.20: ask the server first; a device that already has a contract shows no QR.
    private async Task HandoffAsync(DesktopLoginBilling lb)
    {
        if (handoffAsked) return;
        handoffAsked = true; handoffCancelled = false; var mine = ++epoch;
        try
        {
            serverEntitled = (await lb.CheckAsync(token)).Entitlements.Count != 0;   // asked again here: the person may have waited on the QR for minutes
            if (serverEntitled == true) { if (!token.IsCancellationRequested) Render(); return; }
            handoffWait?.Cancel(); handoffWait = CancellationTokenSource.CreateLinkedTokenSource(token);
            handoff = await lb.StartLoginAsync(Environment.MachineName, handoffWait.Token); serverEntitled = handoff is null;
            if (!token.IsCancellationRequested) Render();
            if (handoff is null) return;
            await lb.WaitForPassAsync(handoffWait.Token);
            if (mine != epoch) return;   // the person pressed やめる
            handoff = null; serverEntitled = true;
        }
        catch (OperationCanceledException) { return; }
        catch (LoginBillingException error) { if (mine != epoch) return; handoff = null; failure = StoreAccountText.Failure(error.Code, error.Status); handoffAsked = false; }
        if (!token.IsCancellationRequested) Render();
    }

    private async Task RunAsync(Func<DesktopLoginBilling, CancellationToken, Task> action)
    {
        if (busy || billing is null) return;
        busy = true; failure = null; handoffWait?.Cancel(); webSignIn = CancellationTokenSource.CreateLinkedTokenSource(token); Render();
        try { await action(billing, webSignIn.Token); handoffAsked = false; serverEntitled = null; busy = false; await LoadAsync(); }
        catch (OperationCanceledException) { }   // the person pressed やめる, or the screen closed
        catch (LoginBillingException error) { failure = StoreAccountText.Failure(error.Code, error.Status); }
        catch (Exception error) { failure = error.Message; }   // the system browser could not be started
        busy = false; webSignIn.Dispose(); webSignIn = null;
        if (!token.IsCancellationRequested) Render();
    }

    private void Render()
    {
        Children.Clear();
        var lb = billing;
        var held = serverEntitled is { } asked ? (asked ? 1 : 0) : lb?.Entitlements?.Count ?? 0;
        var unknown = lb is { PassKind: not PassKind.None } && serverEntitled is null && lb.Entitlements is null;   // null = the server has not answered in this run: not known yet, never "none" (Mint)
        var state = lb is null ? StoreAccountState.SignedOut : StoreAccount.Of(lb.PassKind switch { PassKind.Store => "store", PassKind.Handoff => "handoff", PassKind.Signed => "signed", _ => "none" }, held);
        var entitled = lb is not null && state != StoreAccountState.SignedOut && held != 0;
        var status = StoreAccount.Status(entitled);
        if (!unknown && Entitled != entitled) { Entitled = entitled; EntitledChanged?.Invoke(); }

        var head = new Grid { ColumnDefinitions = new ColumnDefinitions("Auto,*,Auto") };
        var tile = Tile(SettingsPage.Billing, 36); var title = Text(StoreAccountText.Title, 17, Ink, FontWeight.Bold, new Thickness(12, 0, 8, 0)); title.VerticalAlignment = VerticalAlignment.Center;
        Grid.SetColumn(title, 1); head.Children.Add(tile); head.Children.Add(title);
        if (!unknown) { var badge = Badge(status.Badge, status.Tone); Grid.SetColumn(badge, 2); head.Children.Add(badge); }
        Children.Add(head);
        if (lb is null) { Children.Add(Text(StoreAccountText.NotConfigured, 14, Muted, null, new Thickness(0, 10, 0, 0))); return; }
        if (!unknown) Children.Add(Text(state == StoreAccountState.SignedOut ? StoreAccountText.SignedOut : status.Line, 14, Secondary, null, new Thickness(0, 10, 0, 0)));

        if (state != StoreAccountState.SignedOut) Children.Add(AccountRow());
        if (state == StoreAccountState.SignedOut)
        {
            Children.Add(Button(StoreAccountText.SignIn, () => RunAsync((b, cancel) => b.SignInWebAsync("google", ct: cancel)), Look.Primary));
            Children.Add(Button(StoreAccountText.SignInApple, () => RunAsync((b, cancel) => b.SignInWebAsync("apple", ct: cancel)), Look.Primary));
        }
        else
        {
            foreach (var entitlement in checkedEntitlements ?? lb.Entitlements ?? [])
                if (entitled && SubscriptionText.StoreOf(entitlement.Store) is { } store) Children.Add(Text(SubscriptionText.Active(store), 14, Ink, FontWeight.SemiBold, new Thickness(0, 10, 0, 0)));
            if (state == StoreAccountState.Signed && !unknown) RenderSigned(entitled);
            Children.Add(Button(StoreAccountText.SignOut, () => RunAsync(async (b, cancel) => { if (LinuxAccountStore.Home is { } home) await home.EndAsync(cancel); await b.SignOutAsync(cancel); }), Look.Secondary));   // the library's signOut does not end the home session
            RenderDanger();
        }
        if (busy && webSignIn is not null) Children.Add(Waiting());
        if (failure is not null) Children.Add(Banner(failure));
    }

    private Control Waiting()
    {
        var row = new StackPanel { Orientation = Orientation.Horizontal, Spacing = 8, Margin = new Thickness(0, 12, 0, 0) };
        row.Children.Add(Glyph(SettingsIcons.Waiting, 16, Muted)); var text = Text(StoreAccountText.SigningInWeb, 13, Muted); text.VerticalAlignment = VerticalAlignment.Center; row.Children.Add(text);
        var stop = Capsule(StoreAccountText.SigningInWebCancel, Fill, Ink, 12, 14, new Thickness(16, 10)); stop.Click += (_, _) => webSignIn?.Cancel(); row.Children.Add(stop);
        return row;
    }

    // Who is signed in: one label and its mark (never an e-mail or a name; the library has none). A desktop signs in by the browser only.
    private static Control AccountRow()
    {
        var row = new StackPanel { Orientation = Orientation.Horizontal, Spacing = 8, Margin = new Thickness(0, 10, 0, 0) };
        row.Children.Add(Glyph(SettingsIcons.Globe, 18, Secondary));
        var label = Text(StoreAccountText.SignedInBrowser, 14, Ink); label.VerticalAlignment = VerticalAlignment.Center; row.Children.Add(label);
        return row;
    }

    // A desktop never buys here: entitled shows the short summary; otherwise say why and show the QR with one way out.
    private void RenderSigned(bool entitled)
    {
        if (entitled) { Children.Add(Text(StoreAccountText.AlreadyEntitled, 14, Ink, FontWeight.SemiBold, new Thickness(0, 10, 0, 0))); return; }
        Children.Add(Text(StoreAccountText.WebCannotBuy, 13, Muted, null, new Thickness(0, 10, 0, 0)));
        if (handoff is { } login) Children.Add(AccountParts.HandoffBlock(login.QrPayload, login.ShortCode, login.CheckNumber, () => { epoch++; handoffWait?.Cancel(); handoff = null; handoffCancelled = true; Render(); }));
        else if (handoffCancelled)
        {
            Children.Add(Text(StoreAccountText.HandoffCancelled, 13, Muted, null, new Thickness(0, 10, 0, 0)));
            Children.Add(Button(StoreAccountText.HandoffAgain, () => { handoffAsked = false; _ = HandoffAsync(billing!); return Task.CompletedTask; }, Look.Primary));
        }
    }

    // "Stop all others" is destructive: below sign-out, set apart, danger-coloured, with a short reason and a confirm step; it signs in again by the browser with stopOthers.
    private void RenderDanger()
    {
        Children.Add(new Border { Height = 1, Background = Hairline, Margin = new Thickness(0, 16, 0, 4) });
        if (!confirmingStop) { Children.Add(Button(StoreAccountText.StopAllOthers, () => { confirmingStop = true; Render(); return Task.CompletedTask; }, Look.Danger)); return; }
        Children.Add(Text(StoreAccountText.StopAllOthersWhyWeb, 13, Muted, null, new Thickness(0, 8, 0, 0)));
        var row = new StackPanel { Orientation = Orientation.Horizontal, Spacing = 10 };
        // The same provider as the account signed in with: the library does not say which one, so the person picks.
        row.Children.Add(Button(StoreAccountText.StopAllOthersGoogle, () => { confirmingStop = false; return RunAsync((b, cancel) => b.SignInWebAsync("google", stopOthers: true, ct: cancel)); }, Look.DangerFilled));
        row.Children.Add(Button(StoreAccountText.StopAllOthersApple, () => { confirmingStop = false; return RunAsync((b, cancel) => b.SignInWebAsync("apple", stopOthers: true, ct: cancel)); }, Look.DangerFilled));
        row.Children.Add(Button(StoreAccountText.StopAllOthersCancel, () => { confirmingStop = false; Render(); return Task.CompletedTask; }, Look.Secondary));
        Children.Add(row);
    }

    private enum Look { Primary, Secondary, Danger, DangerFilled }

    private Button Button(string label, Func<Task> click, Look look)
    {
        var (background, foreground) = look switch
        {
            Look.Primary => ((IBrush)BellTheme.ProminentFill, (IBrush)Brushes.White),
            Look.DangerFilled => (Red, Brushes.White),
            Look.Danger => (Fill, Red),
            _ => (Fill, Ink),
        };
        var button = Capsule(label, background, foreground, 12, 14, new Thickness(16, 10));
        button.FontWeight = look == Look.Secondary ? FontWeight.Normal : FontWeight.SemiBold; button.HorizontalAlignment = HorizontalAlignment.Left; button.Margin = new Thickness(0, 12, 0, 0); button.IsEnabled = !busy;
        button.Click += async (_, _) => await click();
        return button;
    }
}
