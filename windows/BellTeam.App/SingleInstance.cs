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
    public SingleInstance(Action activate)
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
            pipe.WriteByte(1);
        }
    }
    private async Task ListenAsync(Action activate)
    {
        try
        {
            while (!stop.IsCancellationRequested)
            {
                using var pipe = new NamedPipeServerStream(pipeName, PipeDirection.In, 1, PipeTransmissionMode.Byte, PipeOptions.Asynchronous | PipeOptions.CurrentUserOnly);
                await pipe.WaitForConnectionAsync(stop.Token);
                var signal = new byte[1];
                if (await pipe.ReadAsync(signal, stop.Token) != 0) activate();
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
