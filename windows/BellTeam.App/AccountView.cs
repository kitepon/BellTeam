using System.Windows;
using System.Windows.Controls;
using BellTeam.Core;
using Kitepon.LoginBilling.Desktop;
using static BellTeam.App.SettingsUi;

namespace BellTeam.App;

// a540 (login-billing contract 1.36 s10, the local form): the account and subscription of this PC, in Rapi's words (LocalFormText). The button starts a try: Google signs in on this PC (the library does it inside makeRequest), then the QR a paying phone reads;
// the phone replies over the same Wi-Fi and this PC checks the reply itself and is paid until the period ends. Nothing is bought here and no server takes part. A store the library cannot read (pass_store_unavailable) is shown as that failure and never read as signed out.
internal sealed class AccountView : StackPanel, IDisposable
{
    private enum Look { Primary, Secondary, Danger }
    private readonly DesktopLocal local;
    private readonly Action? deleteAccount;   // 「アカウントを削除」 (asks, then deletes); null where the page has no way to (the first-run gate)
    private readonly CancellationTokenSource life = new();
    private readonly LocalRequestView requestView;
    private readonly Border requestBlock;
    private CancellationTokenSource? attempt;
    private LocalRequest? request;
    private bool signingIn, justPaid;

    // What the first screen (FirstScreenView) draws from: the browser step before the QR, the request on screen, what the last try ended with.
    public bool SigningInWithBrowser => signingIn && request is null;
    public LocalRequest? Request => request;
    public string? Sentence { get; private set; }
    public bool StoreBroken { get; private set; }
    public string? Failure { get; private set; }
    public LocalPaid? Paid { get; private set; }
    public bool Entitled => Paid is not null;
    public event Action? Changed;
    // The running load; tests wait on it.
    public Task Loading { get; private set; } = Task.CompletedTask;

    public AccountView(DesktopLocal local, Action? deleteAccount = null)
    {
        this.local = local; this.deleteAccount = deleteAccount; requestView = new LocalRequestView(provider => _ = StartAsync(provider), CancelBrowser);
        requestBlock = new Border { Child = requestView, Background = SettingsUi.Canvas, CornerRadius = new CornerRadius(16), Padding = new Thickness(16), Margin = new Thickness(0, 12, 0, 0) };
        requestView.ShowIdle(); Render(); Loading = ReloadAsync();
    }

    // signin_cancelled is the person's own choice and says nothing. Also used by the Approval Box sign-in (its library instance throws the same exception).
    internal static string? Describe(LoginBillingException error) => error.Code switch
    {
        "signin_cancelled" => null,
        "return_not_received" => SignInText.ReturnNotReceived,
        _ => StoreAccountText.Failure(error.Detail is null ? error.Code : error.Code + " " + error.Detail),
    };

    // What a try ended with, in the table's words; Windows names the private-network step for a PC that cannot be reached (contract: a Public Wi-Fi).
    internal static string? SentenceOf(LoginBillingException error) => error.Code switch
    {
        "signin_cancelled" => null,
        "return_not_received" => SignInText.ReturnNotReceived,
        "unreachable_same_wifi" => LocalFormText.Of(LocalFormOutcome.PrivateNetwork),
        _ => LocalFormText.Failure(error.Code, error.Status, error.Detail),   // signin_failed carries Apple's own error code (1.46), at that moment only
    };

    // Read what this PC holds; with no accepted period, offer the button.
    public Task ReloadAsync() => Loading = LoadAsync();

    private Task LoadAsync()
    {
        CancelAttempt(); StoreBroken = false; Failure = null; justPaid = false;
        try { Paid = local.PaidUntil(); }
        catch (LoginBillingException error) { StoreBroken = true; Paid = null; Failure = Describe(error); Render(); return Task.CompletedTask; }
        if (Paid is null) requestView.ShowIdle();
        Render();
        return Task.CompletedTask;
    }

    // makeRequest: for Google a fresh sign-in in the browser, then the listener and the QR; for Apple (no Apple sign-in on this PC, contract 1.36 s10) the listener and the QR at once, the iPhone's reply carries its own Apple identity token.
    // The paying phone's reply ends the wait. The person's 「やめる」 ends it quietly.
    public async Task StartAsync(string provider)
    {
        CancelAttempt(); Failure = null; Sentence = null; justPaid = false;
        var mine = attempt = CancellationTokenSource.CreateLinkedTokenSource(life.Token);
        signingIn = true; Render();   // 1.46: Google and Apple both sign in in the browser first
        try
        {
            var made = await local.MakeRequestAsync(provider, AccountStore.OpenBrowser, mine.Token);
            if (mine.IsCancellationRequested) { made.Dispose(); return; }
            request = made; signingIn = false; requestView.ShowRequest(made.Qr, made.ExpiresAt); Render();
            Paid = await made.AwaitPaidAsync(mine.Token); justPaid = true;
        }
        catch (OperationCanceledException) { Sentence = null; requestView.ShowIdle(); }
        catch (LoginBillingException error) { Sentence = SentenceOf(error); requestView.ShowIdle(Sentence); }
        finally { if (ReferenceEquals(attempt, mine)) { signingIn = false; request?.Dispose(); request = null; } }
        if (!life.IsCancellationRequested && ReferenceEquals(attempt, mine)) Render();
    }

    public void CancelBrowser() => attempt?.Cancel();

    private void CancelAttempt() { attempt?.Cancel(); }

    private void SignOut()
    {
        CancelAttempt(); Failure = null;
        try { local.SignOutLocal(); } catch (LoginBillingException error) { Failure = Describe(error); }
        Paid = null; _ = ReloadAsync();
    }

    private void Render()
    {
        Children.Clear();
        var status = StoreAccount.Status(Entitled);
        // Head: tile, title, the one badge; then the state sentence (the Mac page head).
        var head = new Grid(); head.ColumnDefinitions.Add(new ColumnDefinition { Width = GridLength.Auto }); head.ColumnDefinitions.Add(new ColumnDefinition()); head.ColumnDefinitions.Add(new ColumnDefinition { Width = GridLength.Auto });
        head.Children.Add(Tile(SettingsPage.Billing, 36));
        var title = Text(LocalFormText.CardTitle, 20, Ink, FontWeights.Bold, new Thickness(12, 0, 8, 0)); title.VerticalAlignment = VerticalAlignment.Center; Grid.SetColumn(title, 1); head.Children.Add(title);
        var badge = Badge(status.Badge, status.Tone); Grid.SetColumn(badge, 2); head.Children.Add(badge);
        Children.Add(head);
        if (StoreBroken)
        {
            if (Failure is not null) Children.Add(Banner(Failure));
            Children.Add(Button(StoreAccountText.Refresh, () => { _ = ReloadAsync(); return Task.CompletedTask; }, Look.Secondary));
            Changed?.Invoke(); return;
        }
        Children.Add(Text(Paid is { } p ? LocalFormText.Status(p.Until) : LocalFormText.StatusUnpaid, 14, Secondary, null, new Thickness(0, 10, 0, 0)));
        if (Paid is not null)
        {
            if (justPaid) Children.Add(Text(LocalFormText.PaidOk, 14, Ink, FontWeights.SemiBold, new Thickness(0, 6, 0, 0)));
            Children.Add(Button(StoreAccountText.Refresh, () => { _ = ReloadAsync(); return Task.CompletedTask; }, Look.Secondary));
        }
        else if (signingIn && request is null)
        {
            // Google signs in for this request: the browser step before the QR.
            Children.Add(Text(SignInText.Waiting, 14, Muted, null, new Thickness(0, 10, 0, 0)));
            Children.Add(Button(SignInText.Cancel, () => { CancelBrowser(); return Task.CompletedTask; }, Look.Secondary));
        }
        else Children.Add(requestBlock);
        if (!signingIn || request is not null || Paid is not null) Children.Add(Button(StoreAccountText.SignOut, () => { SignOut(); return Task.CompletedTask; }, Look.Secondary));
        RenderDelete();
        if (Failure is not null) Children.Add(Banner(Failure));
        Changed?.Invoke();
    }

    // The last item of the card under a divider, whether signed in or not (a pass or data may be left on this PC).
    private void RenderDelete()
    {
        if (deleteAccount is null) return;
        Children.Add(new Border { Height = 1, Background = Hairline, Margin = new Thickness(0, 16, 0, 4) });
        Children.Add(Button(AccountDeletionText.Button, () => { deleteAccount(); return Task.CompletedTask; }, Look.Danger));
    }

    private Button Button(string label, Func<Task> click, Look look)
    {
        var (background, foreground) = look switch { Look.Primary => (Violet, System.Windows.Media.Brushes.White), Look.Danger => (Fill, Red), _ => (Fill, Ink) };
        var button = Capsule(label, background, foreground, 12, 14, new Thickness(16, 10, 16, 10));
        button.FontWeight = look == Look.Secondary ? FontWeights.Normal : FontWeights.SemiBold; button.HorizontalAlignment = HorizontalAlignment.Left; button.Margin = new Thickness(0, 12, 0, 0);
        System.Windows.Automation.AutomationProperties.SetName(button, label);
        button.Click += async (_, _) => await click();
        return button;
    }

    public void Dispose() { life.Cancel(); request?.Dispose(); }
}

// First run (app-sessions.md 7d, a540; the first-screen-parent-approval row): a device that is not yet paid sees the approval process at once (FirstScreenView: name, purpose, the Owner's first-sign-in text and the sign-in,
// then the QR a parent device reads); a paid one sees サーバーにつなぐ on the account card.
internal sealed class AccountGateView : StartupBackdrop, IDisposable
{
    private readonly AccountView account;
    private readonly FirstScreenView first;
    private readonly Button next;
    private readonly ScrollViewer scroll;
    private readonly Border paid;

    public AccountGateView(DesktopLocal local, Action connect)
    {
        account = new AccountView(local); first = new FirstScreenView(account);
        next = Capsule(StoreAccountText.GateNext, MacUi.ProminentFill, System.Windows.Media.Brushes.White, 12, 15, new Thickness(18, 12, 18, 12));
        next.HorizontalAlignment = HorizontalAlignment.Stretch; next.Margin = new Thickness(0, 18, 0, 0); next.Click += (_, _) => connect();
        System.Windows.Automation.AutomationProperties.SetName(next, StoreAccountText.GateNext);
        var column = new StackPanel(); column.Children.Add(account); column.Children.Add(next);
        paid = Card(column); paid.MaxWidth = 520; paid.Margin = new Thickness(24); paid.HorizontalAlignment = HorizontalAlignment.Center; paid.VerticalAlignment = VerticalAlignment.Center;
        scroll = new ScrollViewer { VerticalScrollBarVisibility = ScrollBarVisibility.Auto, HorizontalScrollBarVisibility = ScrollBarVisibility.Disabled };
        Children.Add(scroll);
        account.Changed += Refresh; Refresh();
    }

    internal AccountView Account => account;

    // Paid: the account card with サーバーにつなぐ. Not paid (or not read yet): the first screen.
    private void Refresh()
    {
        next.Visibility = account.Entitled ? Visibility.Visible : Visibility.Collapsed;
        var show = account.Entitled ? (FrameworkElement)paid : first;
        if (!ReferenceEquals(scroll.Content, show)) scroll.Content = show;
    }

    public void Dispose() => account.Dispose();
}
