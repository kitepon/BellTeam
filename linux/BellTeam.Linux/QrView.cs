using Avalonia;
using Avalonia.Controls;
using Avalonia.Media;
using QRCoder;

namespace BellTeam.Linux;

// Draws the QR text exactly as given (contract 1.20: the text is shown as it is, never inside a link). QRCoder's matrix already carries the quiet zone.
// Every module is a whole number of device pixels (at least 3): a camera reads sharp square modules far better than blurred fractional ones, and the local form's join link is a long text (about 300 characters).
public sealed class QrView : Control
{
    private readonly System.Collections.BitArray[] rows;
    public QrView(string payload, double size)
    {
        using var data = new QRCodeGenerator().CreateQrCode(payload, QRCodeGenerator.ECCLevel.M);
        rows = data.ModuleMatrix.ToArray(); Width = Height = Math.Max(size, 3 * rows.Length);
    }
    public override void Render(DrawingContext context)
    {
        var scale = VisualRoot?.RenderScaling ?? 1;
        var pixels = Math.Max(1, (int)Math.Floor(Width * scale / rows.Length)); var cell = pixels / scale;   // one module = a whole number of device pixels
        var inset = (Width - cell * rows.Length) / 2;
        context.FillRectangle(Brushes.White, new Rect(0, 0, Width, Height));
        for (var y = 0; y < rows.Length; y++) for (var x = 0; x < rows.Length; x++) if (rows[y][x]) context.FillRectangle(Brushes.Black, new Rect(inset + x * cell, inset + y * cell, cell, cell));
    }
}
