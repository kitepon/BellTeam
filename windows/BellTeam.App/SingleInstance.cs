using System.IO;
using System.IO.Pipes;
using System.Security.Principal;

namespace BellTeam.App;

internal sealed class SingleInstance : IDisposable
{
    private readonly Mutex mutex;
    private readonly CancellationTokenSource stop = new();
    private readonly string pipeName;
    public bool IsPrimary { get; }
    // message: the protocol launch URI to forward to the running window, or null for a plain launch.
    public SingleInstance(Action<string?> activate, string? message = null)
    {
        var user = WindowsIdentity.GetCurrent().User!.Value;
        pipeName = "BellTeam-" + user;
        mutex = new Mutex(true, @"Local\" + pipeName, out var primary);
        IsPrimary = primary;
        if (primary) _ = ListenAsync(activate);
        else
        {
            using var pipe = new NamedPipeClientStream(".", pipeName, PipeDirection.Out);
            pipe.Connect(3000);
            var payload = System.Text.Encoding.UTF8.GetBytes((message ?? "") + "\n");
            pipe.Write(payload);
        }
    }
    private async Task ListenAsync(Action<string?> activate)
    {
        try
        {
            while (!stop.IsCancellationRequested)
            {
                using var pipe = new NamedPipeServerStream(pipeName, PipeDirection.In, 1, PipeTransmissionMode.Byte, PipeOptions.Asynchronous | PipeOptions.CurrentUserOnly);
                await pipe.WaitForConnectionAsync(stop.Token);
                using var reader = new StreamReader(pipe, System.Text.Encoding.UTF8);
                var text = await reader.ReadToEndAsync(stop.Token);
                if (text.Length != 0) activate(text.TrimEnd('\n') is { Length: > 0 } launch ? launch : null);
            }
        }
        catch (OperationCanceledException) when (stop.IsCancellationRequested) { }
        catch (Exception error)
        {
            System.Windows.Application.Current.Dispatcher.Invoke(() => System.Windows.MessageBox.Show("既存の窓を開く接続に失敗しました。" + error.Message, "BellTeam"));
        }
    }
    public void Dispose() { stop.Cancel(); stop.Dispose(); if (IsPrimary) mutex.ReleaseMutex(); mutex.Dispose(); }
}
