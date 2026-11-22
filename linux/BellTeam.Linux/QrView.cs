using Avalonia;
using Avalonia.Controls;
using Avalonia.Media;
using QRCoder;

namespace BellTeam.Linux;

// Draws the QR text exactly as given (contract 1.20: the text is shown as it is, never inside a link). QRCoder's matrix already carries the quiet zone.
public sealed class QrView : Control
{
    private readonly System.Collections.BitArray[] rows;
    public QrView(string payload, double size)
    {
        using var data = new QRCodeGenerator().CreateQrCode(payload, QRCodeGenerator.ECCLevel.M);
        rows = data.ModuleMatrix.ToArray(); Width = Height = size;
    }
    public override void Render(DrawingContext context)
    {
        var cell = Width / rows.Length;
        context.FillRectangle(Brushes.White, new Rect(0, 0, Width, Height));
        for (var y = 0; y < rows.Length; y++) for (var x = 0; x < rows.Length; x++) if (rows[y][x]) context.FillRectangle(Brushes.Black, new Rect(x * cell, y * cell, cell + 0.5, cell + 0.5));
    }
}
