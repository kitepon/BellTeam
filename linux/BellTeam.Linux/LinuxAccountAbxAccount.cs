using BellTeam.Core;
using Kitepon.ApprovalBox.Client;

namespace BellTeam.Linux;

// The PC's 決裁箱 client (this file is not linked into the Android app, which passes its own join form): this window joins the Owner's Approval Box as a CHILD device (child-join.md, Owner 2026-11-24).
// Approval Box's own login-billing form lives in its own folder (own key, own kept sign-in), apart from BellTeam's own sign-in (LinuxAccountStore); the sign-in runs in this process, so BellTeam brings only its identifiers:
// the same Google Desktop client and Apple Services ID BellTeam signs in with, which the parent's audiences already list (client-component.md 9.4).
internal sealed partial class LinuxApprovalBoxDevice
{
    internal const string ProductOrigin = "https://approval-box.kitepon.dev";

    public LinuxApprovalBoxDevice(string directory, Func<IReadOnlyList<(string Id, string Name)>> roster)
        : this(ChildJoin(directory), LinuxHasEngine ? new OwnerOnlyPeerStorage(directory, Environment.MachineName, "linux") : null, roster,
            new Uri((Environment.GetEnvironmentVariable("BELLTEAM_APPROVAL_BOX_URL") ?? ProductOrigin).TrimEnd('/'))) { }

    internal static ChildJoinOptions ChildJoin(string directory) => new()
    {
        StateDirectory = Path.Combine(directory, "approval-box-child"),
        Audiences = [.. LocalFormIds.GoogleClientIds, LocalFormIds.GoogleDesktopClientId, LocalFormIds.AppleBundleId, LocalFormIds.AppleServicesId],
        GoogleClientId = LocalFormIds.GoogleDesktopClientId, GoogleClientSecret = LinuxAccountStore.DesktopSecret,
        AppleServicesId = LocalFormIds.AppleServicesId, AppleReturnUrl = LocalFormIds.AppleReturnUrl,
    };
}
