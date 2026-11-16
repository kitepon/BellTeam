namespace BellTeam.Core;

// Zoom and pan of the image viewer (a277). Scale 1 shows the whole picture fitted to the view; offsets are in view pixels from the centred position.
// The picture never leaves the view: the offset is clamped so no more than the zoomed picture's own overhang can be panned.
public sealed class ImageZoom
{
    public const double Min = 1, Max = 8, Step = 1.25, DoubleTapScale = 2.5;
    public double Scale { get; private set; } = 1;
    public double X { get; private set; }
    public double Y { get; private set; }
    private double viewW, viewH, fitW, fitH;
    public bool Zoomed => Scale > Min;

    // The view and the picture fitted into it (both in the same unit); call again when either changes.
    public void Resize(double viewWidth, double viewHeight, double fitWidth, double fitHeight)
    {
        (viewW, viewH, fitW, fitH) = (viewWidth, viewHeight, fitWidth, fitHeight);
        Clamp();
    }
    public void Reset() { Scale = Min; X = Y = 0; }
    // factor multiplies the scale about the point (px, py), given from the view's centre; the picture point under it stays there.
    public void ZoomAt(double factor, double px, double py)
    {
        var scale = Math.Clamp(Scale * factor, Min, Max);
        var ratio = scale / Scale;
        X = px - (px - X) * ratio; Y = py - (py - Y) * ratio; Scale = scale;
        Clamp();
    }
    public void Pan(double dx, double dy) { X += dx; Y += dy; Clamp(); }
    // Double tap: back to fit when zoomed, else DoubleTapScale about the tapped point.
    public void Toggle(double px, double py) { if (Zoomed) Reset(); else ZoomAt(DoubleTapScale, px, py); }
    private void Clamp()
    {
        var overX = Math.Max(0, (fitW * Scale - viewW) / 2); var overY = Math.Max(0, (fitH * Scale - viewH) / 2);
        X = Math.Clamp(X, -overX, overX); Y = Math.Clamp(Y, -overY, overY);
    }
}
