namespace BellTeam.Core;

public sealed class AvatarCrop(double width, double height)
{
    public const double Side = 512;
    public double Zoom { get; private set; } = 1;
    public double OffsetX { get; private set; }
    public double OffsetY { get; private set; }
    public double Scale => Math.Max(Side / width, Side / height) * Zoom;
    public double RenderWidth => width * Scale;
    public double RenderHeight => height * Scale;
    public double Left => (Side - RenderWidth) / 2 + OffsetX;
    public double Top => (Side - RenderHeight) / 2 + OffsetY;
    public void SetZoom(double value) { var ratio = value / Zoom; OffsetX *= ratio; OffsetY *= ratio; Zoom = value; MoveTo(OffsetX, OffsetY); }
    public void MoveTo(double x, double y)
    {
        OffsetX = Math.Clamp(x, -(RenderWidth - Side) / 2, (RenderWidth - Side) / 2);
        OffsetY = Math.Clamp(y, -(RenderHeight - Side) / 2, (RenderHeight - Side) / 2);
    }
}
