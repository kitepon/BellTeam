using System.Net;
using System.Text;
using Avalonia.Controls;
using Avalonia.Controls.Templates;
using Avalonia.Threading;
using BellTeam.Core;

namespace BellTeam.Linux;

public sealed class CodecAndOpeningTests
{
    // A 2x2 lilac/sand checker.
    private static readonly byte[] Png = [137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 13, 73, 72, 68, 82, 0, 0, 0, 2, 0, 0, 0, 2, 8, 6, 0, 0, 0, 114, 182, 13, 36, 0, 0, 0, 22, 73, 68, 65, 84, 120, 156, 99, 120, 54, 109, 203, 255, 105, 251, 46, 253, 103, 0, 17, 32, 14, 0, 112, 66, 12, 169, 254, 53, 102, 152, 0, 0, 0, 0, 73, 69, 78, 68, 174, 66, 96, 130];

    [Fact]
    public Task APastedImageRoundTripsThroughPng() => Ui.Run(async () =>
    {
        var codec = AvaloniaImageCodec.Instance;
        var bitmap = await codec.DecodeAsync(Png);
        Assert.Equal(new Avalonia.PixelSize(2, 2), bitmap.PixelSize);
        var (png, preview) = codec.Pasted(bitmap);
        Assert.Equal("image/png", ImageFile.Mime(png));
        Assert.Same(bitmap, preview);
        Assert.Equal(new Avalonia.PixelSize(2, 2), (await codec.DecodeAsync(png)).PixelSize);
    });

    [Fact]
    public Task ReadAsyncReturnsTheAttachmentAndItsPreview() => Ui.Run(async () =>
    {
        var file = Path.Combine(Directory.CreateTempSubdirectory("bt").FullName, "a.png"); await File.WriteAllBytesAsync(file, Png);
        var (data, preview) = await AvaloniaImageCodec.Instance.ReadAsync(file);
        Assert.Equal(("a.png", "image/png"), (data.Name, data.Mime));
        Assert.Equal(2, preview.PixelSize.Width);
    });

    // MessageCard reads Opening when it loads: the flag may only fall after the layout and Loaded jobs of the first page's cards.
    [Fact]
    public Task TheFirstPagesCardsLoadWhileOpeningIsStillTrue() => Ui.Run(async () =>
    {
        using var workspace = new LinuxWorkspace(origin => new BellApi(origin, new FakeServer()));
        var cards = new List<MessageCard>();
        var list = new ItemsControl { ItemsSource = workspace.Messages, ItemTemplate = new FuncDataTemplate<MessageItem>((item, _) => { var card = new MessageCard(item, workspace); cards.Add(card); return card; }) };
        var window = new Window { Width = 600, Height = 400, Content = list };
        window.Show();
        await workspace.ConnectAsync("http://localhost:1/", listen: false);
        Assert.Null(workspace.ConnectionError);
        await workspace.SelectAsync(workspace.Entries.Single());
        Assert.True(workspace.Opening);
        for (var round = 0; round < 10 && workspace.Opening; round++) { Dispatcher.UIThread.RunJobs(); await Task.Delay(20); }
        Assert.False(workspace.Opening);
        Assert.NotEmpty(cards);
        Assert.All(cards, card => Assert.True(card.EnteredAsOpening));
        window.Close();
    });
}
