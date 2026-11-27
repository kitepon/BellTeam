using Kitepon.ApprovalBox.Client;

namespace BellTeam.Linux;

// A child join's last step, the same as the component's own (Kitepon.ApprovalBox.Client 0.6.1, login-billing 1.56/1.57): the parent's add comes with the reply once its pt verified, before the store proof is judged, so a refused proof still admits this device.
// The wait's refusal is kept only for the failure that follows when there is no add (its own code, else add_missing).
internal static class ChildJoinAccept
{
    public static async Task RunAsync<TAdd, TError>(Func<Task> wait, Func<TAdd?> add, Func<TAdd, Task> send, Func<TError, Exception> failure) where TAdd : class where TError : Exception
    {
        TError? refused = null;
        try { await wait(); }
        catch (TError error) { refused = error; }
        if (add() is not { } found) throw refused is null ? new ChildJoinException("add_missing", null) : failure(refused);
        await send(found);
    }
}
