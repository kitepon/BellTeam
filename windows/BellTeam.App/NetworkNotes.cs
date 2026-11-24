using System.Diagnostics;
using BellTeam.Core;

namespace BellTeam.App;

// The lines under the QR wait: the firewall prompt, the network type when Windows says Public (the phone's answer is dropped there), the security-software line. Windows' own network list answers; no other signal knows the type.
internal static class NetworkNotes
{
    public static IReadOnlyList<string> Lines() => IsPublic() ? [LocalFormText.Firewall, LocalFormText.PublicNetwork, LocalFormText.Blocked] : [LocalFormText.Firewall, LocalFormText.Blocked];

    // INetworkListManager (NLM_ENUM_NETWORK_CONNECTED = 1; NLM_NETWORK_CATEGORY_PUBLIC = 0). An unreadable list leaves the hint out and the failure on the trace: the hint is advice, the QR wait must not depend on it.
    internal static bool IsPublic()
    {
        try
        {
            dynamic list = Activator.CreateInstance(Type.GetTypeFromCLSID(new Guid("DCB00C01-570F-4A9B-8D69-199FDBA5723B"))!)!;
            foreach (dynamic network in list.GetNetworks(1)) if ((int)network.GetCategory() == 0) return true;
        }
        catch (Exception e) { Trace.WriteLine("network type unreadable: " + e.Message); }
        return false;
    }
}
