using BellTeam.Core;
using BellTeam.Linux;
using Kitepon.ApprovalBox.Client;
using Kitepon.LoginBilling;

namespace BellTeam.Android;

// The Approval Box client of this phone (child-join.md; Owner 2026-11-24): the client is the Linux host part (LinuxApprovalBoxDevice, peer storage platform "android") over Kitepon.ApprovalBox.Client; this file is only Android's
// login-billing form for the child join (IChildJoinForm over Kitepon.LoginBilling.Android: the component's Desktop form does not run here). It is Approval Box's own form (client-component.md 9.1): its own storage name,
// so its own key and kept sign-in, apart from BellTeam's own LocalForm (AccountStore). BellTeam brings only its sign-in identifiers, the same as for its own sign-in: the parent's audiences already list them (9.4).
internal sealed class AndroidChildJoinForm : IChildJoinForm
{
    internal const string AppId = "dev.kitepon.approvalbox", Storage = "approvalbox_child";
    private const string Product = "dev.kitepon.approvalbox.monthly";
    // The Play Console key of Approval Box (public; the same value as the component's own Desktop form), because a reply whose store proof fails exposes no add.
    private const string PlayPublicKey = "MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEAwVFt3haadXyc5cfrV5UvMebvmYSGMW5KnO/DX1O2C2NQ0P3692H8r3giN5QC1YhcGYLzQuoQct46tUT0vqLA27y+7QC/jwMGiqj3GheYJI6rPOrwc6TFSQamYZgJzt3rlVhlvHcTjG+xQuQEwJTSG7YoGIbDwgpwd8TBOoozbDBB2bbjpITK73WmtnZM9258IH06+e/Ic+ppPBuaWJAEc8O5SRCFnMD7R5/ZKQBsYp2Z7XxOVba4LNTjhCNp633hxjhmrUxo9V+WOf2C76088ram4+71shntHWohuHYNOlmkdRtOIJoPaJlMPBx/DNwXtOKlcaIk5DsrS4x+lpDluQIDAQAB";
    private readonly Kitepon.LoginBilling.LocalForm local; private readonly Keyholes keys;

    internal AndroidChildJoinForm(global::Android.Content.Context context, Uri origin)
    {
        keys = new Keyholes(context, new Uri(origin, "/v1/").ToString().TrimEnd('/'), AppId, Storage);
        local = new Kitepon.LoginBilling.LocalForm(context, AccountStore.ServerClientId,
            new LocalConfig([.. LocalFormIds.GoogleClientIds, LocalFormIds.AppleBundleId, LocalFormIds.AppleServicesId], Apple: new LocalAppleRules([AppId], [Product]), Play: new LocalPlayRules(AppId, [Product], PlayPublicKey),
                AppleWeb: new LocalAppleWeb(LocalFormIds.AppleServicesId, LocalFormIds.AppleReturnUrl), AppId: AppId),
            Storage, log: null, new LocalKeyholes("child"));
    }

    /// <summary>A product duty of the library: call in the activity's OnCreate, before it starts.</summary>
    internal void RegisterLocalNetwork(global::Android.App.Activity activity) => local.RegisterLocalNetwork(activity);

    public bool HasKey => keys.PublicKey() is not null;
    public string? Header(string method, Uri url, byte[] body) => keys.Header(method, url.ToString(), body);
    public void UseServerTime(long nowMs) => keys.UseServerTime(nowMs);

    public async Task<IChildJoinRequest> MakeRequestAsync(string provider, CancellationToken ct)
    {
        try { var made = await local.MakeRequestAsync(MainActivity.Current, provider, parentAppId: AppId).WaitAsync(ct); return new Request(made, keys, local); }   // signs in itself, also with nothing kept
        catch (LoginBillingException error) { throw new ChildJoinException(error.Code, error); }
    }

    public async Task LeaveAsync(CancellationToken ct)
    {
        try { await keys.LeaveAsync().WaitAsync(ct); }   // the key is deleted whatever the answer
        catch (LoginBillingException error) { throw new ChildJoinException(error.Code, error); }
        finally { local.SignOutLocal(); }
    }

    public void Forget() { keys.DeleteKey(); local.SignOutLocal(); }

    private sealed class Request : IChildJoinRequest
    {
        private readonly LocalRequest request; private readonly Keyholes keys; private readonly Func<string, Task<bool>> taker;
        // 1.60: the join code (made for Approval Box's app id), and this request's return link (lbr1) from the same phone's Approval Box taken while it waits.
        public Request(LocalRequest request, Keyholes keys, Kitepon.LoginBilling.LocalForm local) { this.request = request; this.keys = keys; JoinLink.Takers.Add(taker = JoinLink.Taker(link => local.TakeAsync(link))); }
        public string Qr => request.Qr;
        public string? Code => request.Code;
        public DateTimeOffset ExpiresAt => request.ExpiresAt;
        public async Task AcceptAsync(CancellationToken ct)
        {
            try
            {
                await ChildJoinAccept.RunAsync(() => request.AwaitPaidAsync().WaitAsync(ct), () => request.Add, add => keys.SendAddAsync(add).WaitAsync(ct), (LoginBillingException error) => new ChildJoinException(error.Code, error));
            }
            catch (LoginBillingException error) { throw new ChildJoinException(error.Code, error); }
        }
        public void Dispose() { JoinLink.Takers.Remove(taker); request.Dispose(); }
    }
}

internal static class AndroidApprovalBoxDevice
{
    private static string FilesDir => global::Android.App.Application.Context.FilesDir!.AbsolutePath;
    private static AndroidChildJoinForm? form;
    // Approval Box's origin: product.json's address (a debug build's lab file may point at approval-box's local dev server). No address = no client (the screen says so).
    private static Uri? Origin => ApprovalBoxAccount.AuthUrl is { } url ? new Uri(new Uri(url).GetLeftPart(UriPartial.Authority)) : null;
    private static AndroidChildJoinForm? Form => form ??= Origin is { } origin ? new AndroidChildJoinForm(global::Android.App.Application.Context, origin) : null;

    internal static void RegisterLocalNetwork(global::Android.App.Activity activity) => Form?.RegisterLocalNetwork(activity);

    // Always on (client-v0.5.md 5.3): the server's peer_channel picks /v1 or the device session. The engine is in every ABI of the APK.
    internal static LinuxApprovalBoxDevice? Create(Func<IReadOnlyList<(string Id, string Name)>> roster)
    {
        if (Form is not { } child || Origin is not { } origin) return null;
        return new LinuxApprovalBoxDevice(new ChildJoinOptions { StateDirectory = Path.Combine(FilesDir, "approval-box-child"), Form = child },
            new OwnerOnlyPeerStorage(Path.Combine(FilesDir, "approval-box"), Environment.MachineName, "android"), roster, origin);
    }
}
