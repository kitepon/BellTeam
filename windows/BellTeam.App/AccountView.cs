using System.Windows;
using System.Windows.Controls;
using System.Windows.Media;
using BellTeam.Core;
using Kitepon.LoginBilling.Desktop;
using static BellTeam.App.SettingsUi;

namespace BellTeam.App;

// a487 (login-billing contract 1.20, C# desktop part): the account and subscription of this PC, laid out like the Mac 利用と課金 page and Neon's accepted Android card (sentences: StoreAccountText, SignInText; app-sessions.md 7f).
// Web sign-in, the phone's handoff, the re-check and sign-out go to the library; the pass never reaches this code and no e-mail or name exists anywhere. A Windows PC never buys: with no contract it asks to be let in by a subscribed phone.
// A pass the store cannot read (pass_store_unavailable) is shown as that failure and never read as signed out.
internal sealed class AccountView : StackPanel, IDisposable
{
    private enum Look { Primary, Secondary, Danger, DangerFilled }
    private readonly DesktopLoginBilling? billing;
    private readonly CancellationTokenSource life = new();
    private CancellationTokenSource? browser, handoffWait;
    private bool busy, handoffAsked, handoffCancelled, confirmingStop;
    private bool? serverEntitled;   // CheckAsync's answer: the entitlements kept in this run are empty after a restart and stale after the operator's state changed
    private IReadOnlyList<Entitlement>? checkedEntitlements;
    private LoginStart? handoff;

    public bool Configured => billing is not null;
    // True when no pass is kept (and the store was readable): the first run shows the sign-in entry then.
    public bool SignedOut { get; private set; }
    public bool StoreBroken { get; private set; }
    public SignInPhase Phase { get; private set; } = SignInPhase.Entry;
    public string? Failure { get; private set; }
    public bool Entitled { get; private set; }
    public event Action? Changed;
    // The running load; tests wait on it.
    public Task Loading { get; private set; } = Task.CompletedTask;

    public AccountView(DesktopLoginBilling? billing)
    {
        this.billing = billing; Render();
        Loading = LoadAsync();
    }

    private PassKind? Kind()
    {
        try { StoreBroken = false; return billing?.PassKind; }
        catch (LoginBillingException error) { StoreBroken = true; Failure = Describe(error); return null; }
    }

    // signin_cancelled is the person's own choice and says nothing.
    private static string? Describe(LoginBillingException error) => error.Code switch
    {
        "signin_cancelled" => null,
        "return_not_received" => SignInText.ReturnNotReceived,
        _ => StoreAccountText.Failure(error.Detail is null ? error.Code : error.Code + " " + error.Detail),
    };

    public Task ReloadAsync() => Loading = LoadAsync();

    private async Task LoadAsync()
    {
        if (billing is null) return;
        if (Kind() is null or PassKind.None) { Render(); return; }
        try { var check = await billing.CheckAsync(life.Token); serverEntitled = check.Entitlements.Count != 0; checkedEntitlements = check.Entitlements; }
        catch (OperationCanceledException) { return; }
        catch (LoginBillingException error) { Failure = Describe(error); }
        if (life.IsCancellationRequested) return;
        Render();
        if (Kind() == PassKind.Signed && serverEntitled != true) await HandoffAsync();
    }

    // Contract 1.20: ask the server first; a PC that already has a contract shows no QR. Only a web-signed pass starts a QR login.
    private async Task HandoffAsync()
    {
        if (billing is null || handoffAsked) return;
        handoffAsked = true; handoffCancelled = false;
        var mine = handoffWait = CancellationTokenSource.CreateLinkedTokenSource(life.Token);
        try
        {
            serverEntitled = (await billing.CheckAsync(mine.Token)).Entitlements.Count != 0;   // asked again: the person may have waited on the QR for minutes
            if (serverEntitled == true) { Render(); return; }
            handoff = await billing.StartLoginAsync(Environment.MachineName, mine.Token); serverEntitled = handoff is null;
            Render();
            if (handoff is null) return;
            await billing.WaitForPassAsync(mine.Token);
            handoff = null; serverEntitled = null; handoffAsked = false;
            await LoadAsync();   // the pass came back with the phone's contract: read what it holds
            return;
        }
        catch (OperationCanceledException) { return; }   // やめる or closing: the one who cancelled draws the screen
        catch (LoginBillingException error) { if (mine.IsCancellationRequested) return; handoff = null; Failure = Describe(error); handoffAsked = false; handoffCancelled = true; }
        if (!life.IsCancellationRequested) Render();
    }

    // The sign-in entry of the first run and the button of this page both call this; the browser wait ends with やめる (CancelBrowser).
    public async Task SignInAsync(string provider, bool stopOthers = false)
    {
        if (busy || billing is null) return;
        busy = true; confirmingStop = false; Failure = null; Phase = SignInPhase.Waiting;
        var mine = browser = CancellationTokenSource.CreateLinkedTokenSource(life.Token); Render();
        try { await billing.SignInWebAsync(provider, null, stopOthers, mine.Token); serverEntitled = null; checkedEntitlements = null; handoffAsked = false; Phase = SignInPhase.Entry; }
        catch (OperationCanceledException) { Phase = SignInPhase.Entry; }
        catch (LoginBillingException error) { Failure = Describe(error); Phase = error.Code == "return_not_received" ? SignInPhase.ReturnNotReceived : SignInPhase.Entry; }
        browser = null; busy = false;
        if (!life.IsCancellationRequested) await LoadAsync();
    }

    public void CancelBrowser() => browser?.Cancel();

    private async Task RunAsync(Func<DesktopLoginBilling, Task> action)
    {
        if (busy || billing is null) return;
        busy = true; Failure = null; Render();
        try { await action(billing); handoffAsked = false; serverEntitled = null; checkedEntitlements = null; }
        catch (LoginBillingException error) { Failure = Describe(error); }
        busy = false;
        if (!life.IsCancellationRequested) await LoadAsync();
    }

    private void Render()
    {
        Children.Clear();
        var kind = Kind();
        SignedOut = billing is not null && kind is PassKind.None;
        var entitled = kind is not null && !SignedOut && (serverEntitled ?? billing?.Entitlements is { Count: > 0 });
        var status = StoreAccount.Status(entitled);
        if (Entitled != entitled) Entitled = entitled;

        // Head: tile, title, the one badge; then the state sentence (the Mac page head).
        var head = new Grid(); head.ColumnDefinitions.Add(new ColumnDefinition { Width = GridLength.Auto }); head.ColumnDefinitions.Add(new ColumnDefinition()); head.ColumnDefinitions.Add(new ColumnDefinition { Width = GridLength.Auto });
        head.Children.Add(Tile(SettingsPage.Billing, 36));
        var title = Text(StoreAccountText.Title, 20, Ink, FontWeights.Bold, new Thickness(12, 0, 8, 0)); title.VerticalAlignment = VerticalAlignment.Center; Grid.SetColumn(title, 1); head.Children.Add(title);
        var badge = Badge(status.Badge, status.Tone); Grid.SetColumn(badge, 2); head.Children.Add(badge);
        Children.Add(head);
        if (billing is null) { Children.Add(Text(StoreAccountText.NotConfigured, 14, Muted, null, new Thickness(0, 10, 0, 0))); Changed?.Invoke(); return; }
        if (StoreBroken)
        {
            if (Failure is not null) Children.Add(Banner(Failure));
            Children.Add(Button(StoreAccountText.Refresh, () => { _ = ReloadAsync(); return Task.CompletedTask; }, Look.Secondary));
            Changed?.Invoke(); return;
        }
        Children.Add(Text(SignedOut ? StoreAccountText.SignedOut : status.Line, 14, Secondary, null, new Thickness(0, 10, 0, 0)));

        if (SignedOut)
        {
            if (Phase == SignInPhase.Waiting)
            {
                Children.Add(Text(SignInText.Waiting, 14, Muted, null, new Thickness(0, 10, 0, 0)));
                Children.Add(Button(SignInText.Cancel, () => { CancelBrowser(); return Task.CompletedTask; }, Look.Secondary, enabled: true));
            }
            else
            {
                foreach (var provider in AccountStore.Providers) Children.Add(Button(provider == "apple" ? SignInText.Apple : SignInText.Google, () => SignInAsync(provider), Look.Primary));
                Children.Add(Text(SignInText.Note, 12, Muted, null, new Thickness(0, 10, 0, 0)));
            }
        }
        else
        {
            Children.Add(AccountRow());
            foreach (var entitlement in checkedEntitlements ?? billing.Entitlements ?? [])
                if (entitled && SubscriptionText.StoreOf(entitlement.Store) is { } store) Children.Add(Text(SubscriptionText.Active(store), 14, Ink, FontWeights.SemiBold, new Thickness(0, 10, 0, 0)));
            if (kind == PassKind.Signed) RenderSigned(entitled);
            Children.Add(Button(StoreAccountText.Refresh, () => RunAsync(_ => Task.CompletedTask), Look.Secondary));
            if (Phase == SignInPhase.Waiting) { Children.Add(Text(SignInText.Waiting, 14, Muted, null, new Thickness(0, 10, 0, 0))); Children.Add(Button(SignInText.Cancel, () => { CancelBrowser(); return Task.CompletedTask; }, Look.Secondary, enabled: true)); }
            else
            {
                Children.Add(Button(StoreAccountText.SignOut, () => RunAsync(b => b.SignOutAsync(life.Token)), Look.Secondary));
                RenderDanger();
            }
        }
        if (Failure is not null) Children.Add(Banner(Failure));
        Changed?.Invoke();
    }

    // Who is signed in: the browser mark and one label (never an e-mail or a name; the library has none).
    private static UIElement AccountRow()
    {
        var row = new StackPanel { Orientation = Orientation.Horizontal, Margin = new Thickness(0, 10, 0, 0) };
        row.Children.Add(Glyph("\uE774", 16, Secondary)); // the globe, as 接続 uses
        var label = Text(StoreAccountText.SignedInBrowser, 14, Ink, null, new Thickness(8, 0, 0, 0)); label.VerticalAlignment = VerticalAlignment.Center; row.Children.Add(label);
        return row;
    }

    // A web-signed PC never buys here: entitled shows the short summary; otherwise say why and show the QR with one way out.
    private void RenderSigned(bool entitled)
    {
        if (entitled) { Children.Add(Text(StoreAccountText.AlreadyEntitled, 14, Ink, FontWeights.SemiBold, new Thickness(0, 10, 0, 0))); return; }
        Children.Add(Text(StoreAccountText.WebCannotBuy, 13, Muted, null, new Thickness(0, 10, 0, 0)));
        if (handoff is { } login)
        {
            var block = new StackPanel();
            block.Children.Add(Text(StoreAccountText.HandoffTitle, 16, Ink, FontWeights.Bold));
            block.Children.Add(Text(StoreAccountText.HandoffLead, 13, Muted, null, new Thickness(0, 6, 0, 0)));
            var qr = new QrView(login.QrPayload, 220) { HorizontalAlignment = HorizontalAlignment.Center, Margin = new Thickness(0, 10, 0, 10) }; block.Children.Add(qr);
            var pair = new Grid(); pair.ColumnDefinitions.Add(new ColumnDefinition()); pair.ColumnDefinitions.Add(new ColumnDefinition());
            var code = Pair(StoreAccountText.HandoffCode, login.ShortCode); var check = Pair(StoreAccountText.HandoffCheckNumber, login.CheckNumber); Grid.SetColumn(check, 1);
            pair.Children.Add(code); pair.Children.Add(check); block.Children.Add(pair);
            block.Children.Add(Text(StoreAccountText.HandoffCheckLine, 12, Muted, null, new Thickness(0, 6, 0, 0)));
            block.Children.Add(Text(StoreAccountText.HandoffWaiting, 13, Muted, null, new Thickness(0, 8, 0, 0)));
            block.Children.Add(Button(StoreAccountText.HandoffCancel, () => { handoffWait?.Cancel(); handoff = null; handoffCancelled = true; handoffAsked = false; Render(); return Task.CompletedTask; }, Look.Secondary, enabled: true));
            Children.Add(new Border { Child = block, Background = SettingsUi.Canvas, CornerRadius = new CornerRadius(16), Padding = new Thickness(16), Margin = new Thickness(0, 12, 0, 0) });
        }
        else if (handoffCancelled)
        {
            if (Failure is null) Children.Add(Text(StoreAccountText.HandoffCancelled, 13, Muted, null, new Thickness(0, 10, 0, 0)));
            Children.Add(Button(StoreAccountText.HandoffAgain, () => { _ = HandoffAsync(); return Task.CompletedTask; }, Look.Primary));
        }
    }

    private static UIElement Pair(string label, string value)
    {
        var column = new StackPanel();
        column.Children.Add(Text(label, 12, Muted)); column.Children.Add(Text(value, 20, Ink, FontWeights.Bold, new Thickness(0, 2, 0, 0)));
        System.Windows.Automation.AutomationProperties.SetName(column, label + " " + value);
        return column;
    }

    // "Stop all others" is destructive: below sign-out, set apart, danger-coloured, with a short reason and a confirm step. The library signs in again in the same step (stopOthers).
    private void RenderDanger()
    {
        Children.Add(new Border { Height = 1, Background = Hairline, Margin = new Thickness(0, 16, 0, 4) });
        if (!confirmingStop) { Children.Add(Button(StoreAccountText.StopAllOthers, () => { confirmingStop = true; Render(); return Task.CompletedTask; }, Look.Danger)); return; }
        Children.Add(Text(StoreAccountText.StopAllOthersWhy, 13, Muted, null, new Thickness(0, 8, 0, 0)));
        var row = new StackPanel { Orientation = Orientation.Horizontal };
        var stop = Button(StoreAccountText.StopAllOthersConfirm, () => SignInAsync(AccountStore.Providers[0], stopOthers: true), Look.DangerFilled);
        var cancel = Button(StoreAccountText.StopAllOthersCancel, () => { confirmingStop = false; Render(); return Task.CompletedTask; }, Look.Secondary); cancel.Margin = new Thickness(10, 12, 0, 0);
        row.Children.Add(stop); row.Children.Add(cancel); Children.Add(row);
    }

    private Button Button(string label, Func<Task> click, Look look, bool enabled = false)
    {
        var (background, foreground) = look switch
        {
            Look.Primary => (Violet, Brushes.White),
            Look.DangerFilled => (Red, Brushes.White),
            Look.Danger => (Fill, Red),
            _ => (Fill, Ink),
        };
        var button = Capsule(label, background, foreground, 12, 14, new Thickness(16, 10, 16, 10));
        button.FontWeight = look == Look.Secondary ? FontWeights.Normal : FontWeights.SemiBold; button.HorizontalAlignment = HorizontalAlignment.Left; button.Margin = new Thickness(0, 12, 0, 0); button.IsEnabled = enabled || !busy;
        System.Windows.Automation.AutomationProperties.SetName(button, label);
        button.Click += async (_, _) => await click();
        return button;
    }

    public void Dispose() { life.Cancel(); }
}

// First run, steps 1 and 2 of app-sessions.md 7d: the sign-in entry while no pass is kept, then the account screen (with the handoff QR when there is no contract), then サーバーにつなぐ once a contract exists.
internal sealed class AccountGateView : StartupBackdrop, IDisposable
{
    private readonly AccountView account;
    private readonly SignInView entry;
    private readonly FrameworkElement card;
    private readonly Button next;

    public AccountGateView(DesktopLoginBilling? billing, Action connect)
    {
        account = new AccountView(billing);
        entry = new SignInView(provider => _ = account.SignInAsync(provider), account.CancelBrowser, AccountStore.Providers);
        next = Capsule(StoreAccountText.GateNext, MacUi.ProminentFill, Brushes.White, 12, 15, new Thickness(18, 12, 18, 12));
        next.HorizontalAlignment = HorizontalAlignment.Stretch; next.Margin = new Thickness(0, 18, 0, 0); next.Click += (_, _) => connect();
        System.Windows.Automation.AutomationProperties.SetName(next, StoreAccountText.GateNext);
        var column = new StackPanel(); column.Children.Add(account); column.Children.Add(next);
        var holder = Card(column); holder.MaxWidth = 520; holder.Margin = new Thickness(24); holder.HorizontalAlignment = HorizontalAlignment.Center; holder.VerticalAlignment = VerticalAlignment.Center;
        card = new ScrollViewer { VerticalScrollBarVisibility = ScrollBarVisibility.Auto, HorizontalScrollBarVisibility = ScrollBarVisibility.Disabled, Content = holder };
        Children.Add(card); Children.Add(entry);
        account.Changed += Refresh; Refresh();
    }

    internal AccountView Account => account;

    private void Refresh()
    {
        var entering = account.Configured && account.SignedOut && !account.StoreBroken;
        entry.Visibility = entering ? Visibility.Visible : Visibility.Collapsed; card.Visibility = entering ? Visibility.Collapsed : Visibility.Visible;
        if (entering) entry.Show(account.Phase, account.Phase == SignInPhase.ReturnNotReceived ? null : account.Failure);
        next.Visibility = account.Entitled ? Visibility.Visible : Visibility.Collapsed;
    }

    public void Dispose() => account.Dispose();
}
