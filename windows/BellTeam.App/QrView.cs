using System.Collections;
using System.Windows;
using System.Windows.Media;
using QRCoder;

namespace BellTeam.App;

// Draws the QR text exactly as the library gives it (the Approval Box handoff's text, the local form's join link of 1.49). QRCoder's matrix already carries the quiet zone.
// Every module is a whole number of pixels (at least 3, about size / modules): a camera reads sharp square modules far better than blurred fractional ones.
internal sealed class QrView : FrameworkElement
{
    private readonly BitArray[] rows;
    private readonly double cell;
    public QrView(string payload, double size, string name = "QR")
    {
        using var data = new QRCodeGenerator().CreateQrCode(payload, QRCodeGenerator.ECCLevel.M);
        rows = data.ModuleMatrix.ToArray(); cell = Math.Max(3, Math.Round(size / rows.Length)); Width = Height = cell * rows.Length; SnapsToDevicePixels = true; UseLayoutRounding = true;
        System.Windows.Automation.AutomationProperties.SetName(this, name);
    }
    protected override void OnRender(DrawingContext context)
    {
        context.DrawRectangle(Brushes.White, null, new Rect(0, 0, Width, Height));
        for (var y = 0; y < rows.Length; y++) for (var x = 0; x < rows.Length; x++) if (rows[y][x]) context.DrawRectangle(Brushes.Black, null, new Rect(x * cell, y * cell, cell, cell));
    }
}
