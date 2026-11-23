using System.Windows;
using System.Windows.Controls;
using BellTeam.Core;
using Kitepon.LoginBilling.Desktop;
using static BellTeam.App.SettingsUi;

namespace BellTeam.App;

// a540 (login-billing contract 1.36 s10, the local form): the account and subscription of this PC. Google signs in on this PC; the paying phone reads the QR and replies over the same Wi-Fi; this PC checks the reply itself and is paid until the period ends.
// Nothing is bought here and no server takes part. Sentences: LocalFormText, SignInText, StoreAccountText. A store the library cannot read (pass_store_unavailable) is shown as that failure and never read as signed out.
internal sealed class AccountView : StackPanel, IDisposable
{
    private enum Look { Primary, Secondary, Danger }
    private const string PaidNoEnd = "購読を確認しました。";   // a purchase with no end (the library's until is empty)
    private readonly DesktopLocal local;
    private readonly Action? deleteAccount;   // 「アカウントを削除」 (asks, then deletes); null where the page has no way to (the first-run gate)
    private readonly CancellationTokenSource life = new();
    private readonly LocalRequestView requestView;
    private readonly Border requestBlock;
    private CancellationTokenSource? attempt;
    private LocalRequest? request;
    private bool requesting, stopped;

    // No try yet: the screen offers the Google button, which starts one (makeRequest signs in by itself; Mint 2026-11-23, contract 1.36).
    public bool NotStarted { get; private set; }
    public bool StoreBroken { get; private set; }
    public SignInPhase Phase { get; private set; } = SignInPhase.Entry;
    public string? Failure { get; private set; }
    public LocalPaid? Paid { get; private set; }
    public bool Entitled => Paid is not null;
    public event Action? Changed;
    // The running load; tests wait on it.
    public Task Loading { get; private set; } = Task.CompletedTask;

    public AccountView(DesktopLocal local, Action? deleteAccount = null)
    {
        this.local = local; this.deleteAccount = deleteAccount; requestView = new LocalRequestView(() => _ = StartRequestAsync(), CancelBrowser);
        requestBlock = new Border { Child = requestView, Background = SettingsUi.Canvas, CornerRadius = new CornerRadius(16), Padding = new Thickness(16), Margin = new Thickness(0, 12, 0, 0) };
        Render(); Loading = ReloadAsync();
    }

    // signin_cancelled is the person's own choice and says nothing. Also used by the Approval Box sign-in (its library instance throws the same exception).
    internal static string? Describe(LoginBillingException error) => error.Code switch
    {
        "signin_cancelled" => null,
        "return_not_received" => SignInText.ReturnNotReceived,
        _ => StoreAccountText.Failure(error.Detail is null ? error.Code : error.Code + " " + error.Detail),
    };

    // Read what this PC holds; with no accepted period, ask for a new QR.
    public Task ReloadAsync() => Loading = LoadAsync();

    private async Task LoadAsync()
    {
        CancelAttempt(); StoreBroken = false; Failure = null; stopped = false;
        try { Paid = local.PaidUntil(); }
        catch (LoginBillingException error) { StoreBroken = true; Paid = null; Failure = Describe(error); Render(); return; }
        NotStarted = Paid is null; Render();
    }

    // makeRequest: for Google a fresh sign-in in the browser, then the listener and the QR; the paying phone's reply ends the wait. The person's 「やめる」 ends it quietly.
    public Task StartAsync() => StartRequestAsync();

    private async Task StartRequestAsync()
    {
        CancelAttempt(); Failure = null; stopped = false; NotStarted = false;
        var mine = attempt = CancellationTokenSource.CreateLinkedTokenSource(life.Token);
        requesting = true; Phase = SignInPhase.Waiting; Render();
        try
        {
            var made = await local.MakeRequestAsync("google", AccountStore.OpenBrowser, mine.Token);
            if (mine.IsCancellationRequested) { made.Dispose(); return; }
            request = made; Phase = SignInPhase.Entry; requestView.ShowRequest(made.Qr); Render();
            Paid = await made.AwaitPaidAsync(mine.Token);
            requestView.ShowOutcome(LocalFormOutcome.Paid, Paid.Until);
        }
        catch (OperationCanceledException) { if (!life.IsCancellationRequested) stopped = true; }
        catch (LoginBillingException error) when (error.Code is "signin_cancelled") { stopped = true; }
        catch (LoginBillingException error) when (error.Code is not "return_not_received") { requestView.ShowSentence(error.Code == "unreachable_same_wifi" ? LocalFormText.Of(LocalFormOutcome.PrivateNetwork) : LocalFormText.Failure(error.Code, error.Status)); }
        catch (LoginBillingException error) { Failure = Describe(error); Phase = error.Code == "return_not_received" ? SignInPhase.ReturnNotReceived : SignInPhase.Entry; stopped = true; }
        finally { if (ReferenceEquals(attempt, mine)) { requesting = false; request?.Dispose(); request = null; if (Phase == SignInPhase.Waiting) Phase = SignInPhase.Entry; } }
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
        var title = Text(StoreAccountText.Title, 20, Ink, FontWeights.Bold, new Thickness(12, 0, 8, 0)); title.VerticalAlignment = VerticalAlignment.Center; Grid.SetColumn(title, 1); head.Children.Add(title);
        var badge = Badge(status.Badge, status.Tone); Grid.SetColumn(badge, 2); head.Children.Add(badge);
        Children.Add(head);
        if (StoreBroken)
        {
            if (Failure is not null) Children.Add(Banner(Failure));
            Children.Add(Button(StoreAccountText.Refresh, () => { _ = ReloadAsync(); return Task.CompletedTask; }, Look.Secondary));
            Changed?.Invoke(); return;
        }
        Children.Add(Text(NotStarted ? StoreAccountText.SignedOut : status.Line, 14, Secondary, null, new Thickness(0, 10, 0, 0)));
        if (NotStarted)
        {
            if (Phase == SignInPhase.Waiting) { Children.Add(Text(SignInText.Waiting, 14, Muted, null, new Thickness(0, 10, 0, 0))); Children.Add(Button(SignInText.Cancel, () => { CancelBrowser(); return Task.CompletedTask; }, Look.Secondary)); }
            else
            {
                Children.Add(Button(SignInText.Google, StartAsync, Look.Primary));
                Children.Add(Text(SignInText.Note, 12, Muted, null, new Thickness(0, 10, 0, 0)));
            }
        }
        else if (Paid is { } paid)
        {
            Children.Add(Text(paid.Until is { } until ? LocalFormText.Paid(until) : PaidNoEnd, 14, Ink, FontWeights.SemiBold, new Thickness(0, 10, 0, 0)));
            Children.Add(Button(StoreAccountText.Refresh, () => { _ = ReloadAsync(); return Task.CompletedTask; }, Look.Secondary));
            Children.Add(Button(StoreAccountText.SignOut, () => { SignOut(); return Task.CompletedTask; }, Look.Secondary));
        }
        else if (requesting && request is null)
        {
            // Google signs in again for this request: the browser step before the QR.
            Children.Add(Text(SignInText.Waiting, 14, Muted, null, new Thickness(0, 10, 0, 0)));
            Children.Add(Button(SignInText.Cancel, () => { CancelBrowser(); return Task.CompletedTask; }, Look.Secondary));
        }
        else
        {
            if (stopped) requestView.ShowStopped();
            Children.Add(requestBlock);
            Children.Add(Button(StoreAccountText.SignOut, () => { SignOut(); return Task.CompletedTask; }, Look.Secondary));
        }
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
        button.FontWeight = look == Look.Secondary ? FontWeights.Normal : FontWeights.SemiBold; button.HorizontalAlignment = HorizontalAlignment.Left; button.Margin = new Thickness(0, 12, 0, 0); button.IsEnabled = true;
        System.Windows.Automation.AutomationProperties.SetName(button, label);
        button.Click += async (_, _) => await click();
        return button;
    }

    public void Dispose() { life.Cancel(); request?.Dispose(); }
}

// First run (app-sessions.md 7d, a540): the sign-in entry while this PC is not signed in, then the account screen with the QR a paying phone reads, then サーバーにつなぐ once the period is paid.
internal sealed class AccountGateView : StartupBackdrop, IDisposable
{
    private readonly AccountView account;
    private readonly SignInView entry;
    private readonly FrameworkElement card;
    private readonly Button next;

    public AccountGateView(DesktopLocal local, Action connect)
    {
        account = new AccountView(local);
        entry = new SignInView(provider => _ = account.StartAsync(), account.CancelBrowser, AccountStore.Providers);
        next = Capsule(StoreAccountText.GateNext, MacUi.ProminentFill, System.Windows.Media.Brushes.White, 12, 15, new Thickness(18, 12, 18, 12));
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
        var entering = account.NotStarted && !account.StoreBroken;
        entry.Visibility = entering ? Visibility.Visible : Visibility.Collapsed; card.Visibility = entering ? Visibility.Collapsed : Visibility.Visible;
        if (entering) entry.Show(account.Phase, account.Phase == SignInPhase.ReturnNotReceived ? null : account.Failure);
        next.Visibility = account.Entitled ? Visibility.Visible : Visibility.Collapsed;
    }

    public void Dispose() => account.Dispose();
}
