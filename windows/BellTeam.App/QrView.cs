using System.Collections;
using System.Windows;
using System.Windows.Media;
using QRCoder;

namespace BellTeam.App;

// Draws the QR text exactly as given (contract 1.20: never inside a link). QRCoder's matrix already carries the quiet zone.
internal sealed class QrView : FrameworkElement
{
    private readonly BitArray[] rows;
    public QrView(string payload, double size)
    {
        using var data = new QRCodeGenerator().CreateQrCode(payload, QRCodeGenerator.ECCLevel.M);
        rows = data.ModuleMatrix.ToArray(); Width = Height = size; SnapsToDevicePixels = true;
        System.Windows.Automation.AutomationProperties.SetName(this, "QR");
    }
    protected override void OnRender(DrawingContext context)
    {
        var cell = Width / rows.Length;
        context.DrawRectangle(Brushes.White, null, new Rect(0, 0, Width, Height));
        for (var y = 0; y < rows.Length; y++) for (var x = 0; x < rows.Length; x++) if (rows[y][x]) context.DrawRectangle(Brushes.Black, null, new Rect(x * cell, y * cell, cell + 0.5, cell + 0.5));
    }
}
