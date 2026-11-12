using Avalonia.Controls;
using BellTeam.Core;

namespace BellTeam.Linux;

// Stub for the merge to drop: the secret input window is ported by the requests group. The signature carries the arguments of the Windows constructor plus the owner window.
public static class SecretInputWindow
{
    public static Task ShowAsync(Window owner, SecretRequest request, Func<SecretSubmission?, Task<SecretRequest>> finish, Func<Task<OnePasswordKey[]?>> loadKeys, Action<SecretRequest> completed)
        => throw new NotSupportedException("秘密の入力欄はLinux版ではまだ使えません。");
}
