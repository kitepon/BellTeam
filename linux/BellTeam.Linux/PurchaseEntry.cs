using Avalonia;
using Avalonia.Controls;
using Avalonia.Layout;
using Avalonia.Media;
using BellTeam.Core;
using static BellTeam.Linux.SettingsUi;

namespace BellTeam.Linux;

// 利用と課金 on Linux and Android (a485): nothing is bought in these apps. It shows what the server reports and, while there is no live contract, one sentence: buy on an iPhone, iPad or Mac and log this server in.
// A field the server leaves out reads as "none" (Bready: no isTrial, billingSources or canPurchase from Stripe any more).
public sealed class PurchaseEntry : StackPanel
{
    private readonly SubscriptionApi api;
    private readonly CancellationToken token;
    private SubscriptionState? state;
    private string? failure;
    private bool busy;

    public PurchaseEntry(SubscriptionApi api, CancellationToken token)
    {
        this.api = api; this.token = token;
        Margin = new Thickness(0, 14, 0, 0);
    }

    internal SubscriptionState? State => state;

    public async Task LoadAsync()
    {
        if (busy) return;
        busy = true; failure = null; Render();
        try { state = await api.GetAsync(token); }
        catch (OperationCanceledException) when (token.IsCancellationRequested) { return; }
        catch (Exception error) { failure = "購読の状態を確認できませんでした。再確認してください。" + error.Message; }
        busy = false; Render();
    }

    private void Render()
    {
        Children.Clear();
        // A developer server needs no subscription: nothing to say.
        if (state is { AccessMode: "developer" }) return;
        if (state is { Entitled: true } now)
        {
            if (SubscriptionText.StoreOf(now.Source) is { } store) Children.Add(Text(SubscriptionText.Active(store), 14, Ink, FontWeight.SemiBold, new Thickness(0, 0, 0, 4)));
            foreach (var line in SubscriptionText.StateLines(now)) Children.Add(Text(line, 13, Ink, null, new Thickness(0, 0, 0, 4)));
        }
        else if (state is not null) Children.Add(Text(SubscriptionText.BuyOnApple, 14, Ink));
        var recheck = Capsule(SubscriptionText.Recheck, Fill, Ink, 8, 13, new Thickness(12, 6)); recheck.IsEnabled = !busy; recheck.FontWeight = FontWeight.Normal; recheck.HorizontalAlignment = HorizontalAlignment.Left; recheck.Margin = new Thickness(0, 8, 0, 0);
        recheck.Click += async (_, _) => await LoadAsync();
        Children.Add(recheck);
        if (failure is not null) Children.Add(Banner(failure));
    }
}
