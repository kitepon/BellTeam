using System.Net;
using System.Net.Http;
using System.Net.WebSockets;
using BellTeam.PeerChannel;

namespace BellTeam.Tests;

// docs/signaling.md of contract 0.5.8: close code 4401 pass_ended is a sign-out; /pc/v1/turn refuses with 403 {"error": the product's not_entitled code}.
public class PeerChannelSignalTests
{
    private static HttpListener Listen(out Uri url)
    {
        var port = new Random().Next(20000, 40000); var l = new HttpListener(); l.Prefixes.Add($"http://localhost:{port}/"); l.Start();
        url = new Uri($"http://localhost:{port}"); return l;
    }

    [Fact]
    public async Task A_socket_closed_with_4401_reports_pass_ended()
    {
        using var listener = Listen(out var url);
        var server = Task.Run(async () =>
        {
            var ws = (await (await listener.GetContextAsync()).AcceptWebSocketAsync(null)).WebSocket;
            await Task.Delay(300); // the client subscribes to Closed first
            await ws.CloseOutputAsync((WebSocketCloseStatus)SignalSocket.PassEnded, "pass_ended", CancellationToken.None);
        });
        var closed = new TaskCompletionSource();
        await using var socket = await SignalSocket.OpenAsync(new ServerAccess(url, new Dictionary<string, string>()), CancellationToken.None);
        socket.Closed += () => closed.TrySetResult();
        socket.Start();
        await closed.Task.WaitAsync(TimeSpan.FromSeconds(10)); await server;
        Assert.Equal(SignalSocket.PassEnded, socket.CloseCode);
    }

    [Fact]
    public async Task A_frame_and_a_close_that_arrive_before_the_owner_subscribed_are_still_delivered()
    {
        using var listener = Listen(out var url);
        var server = Task.Run(async () =>
        {
            var ws = (await (await listener.GetContextAsync()).AcceptWebSocketAsync(null)).WebSocket;
            await ws.SendAsync("{\"type\":\"error\",\"of\":\"join\",\"code\":\"not_entitled\"}"u8.ToArray(), WebSocketMessageType.Text, true, CancellationToken.None);
            await ws.CloseOutputAsync((WebSocketCloseStatus)SignalSocket.PassEnded, "pass_ended", CancellationToken.None);
        });
        await using var socket = await SignalSocket.OpenAsync(new ServerAccess(url, new Dictionary<string, string>()), CancellationToken.None);
        await server; await Task.Delay(300); // the frame and the close are already on the wire when the owner subscribes
        var message = new TaskCompletionSource<string>(); var closed = new TaskCompletionSource();
        socket.Message += doc => message.TrySetResult(doc.RootElement.GetProperty("code").GetString()!);
        socket.Closed += () => closed.TrySetResult();
        socket.Start();
        Assert.Equal("not_entitled", await message.Task.WaitAsync(TimeSpan.FromSeconds(10)));
        await closed.Task.WaitAsync(TimeSpan.FromSeconds(10));
        Assert.Equal(SignalSocket.PassEnded, socket.CloseCode);
    }

    [Fact]
    public async Task Turn_403_carries_the_product_code()
    {
        using var listener = Listen(out var url);
        var server = Task.Run(async () =>
        {
            var c = await listener.GetContextAsync(); c.Response.StatusCode = 403;
            var body = "{\"error\":\"no_entitlement\"}"u8.ToArray(); await c.Response.OutputStream.WriteAsync(body); c.Response.Close();
        });
        var e = await Assert.ThrowsAsync<TurnRefusedException>(() => SignalHttp.FetchTurnAsync(new HttpClient(), new ServerAccess(url, new Dictionary<string, string>()), CancellationToken.None));
        await server;
        Assert.Equal((403, "no_entitlement"), (e.Status, e.Code));
    }
}
