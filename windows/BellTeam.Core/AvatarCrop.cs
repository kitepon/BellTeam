namespace BellTeam.Core;

// side: the output canvas edge (512 for a small image, 1024 for a large one).
public sealed class AvatarCrop(double width, double height, double side = 512)
{
    public double Side { get; } = side;
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
    // The visible part of the image as fractions of it: the "crop" the server stores (Mac AvatarImage.cropRect).
    public AvatarCropRect Rect => new(((RenderWidth - Side) / 2 - OffsetX) / RenderWidth, ((RenderHeight - Side) / 2 - OffsetY) / RenderHeight, Side / RenderWidth, Side / RenderHeight);
    // Mac AvatarImage.placement: null when the stored rect cannot be placed on this image.
    public static AvatarCrop? From(double width, double height, double side, AvatarCropRect crop)
    {
        if (width <= 0 || height <= 0 || crop.Width <= 0 || crop.Height <= 0 || crop.X < 0 || crop.Y < 0 || crop.X + crop.Width > 1.000001 || crop.Y + crop.Height > 1.000001) return null;
        var result = new AvatarCrop(width, height, side);
        var basis = Math.Max(side / width, side / height);
        var scale = Math.Max(basis, Math.Max(side / (crop.Width * width), side / (crop.Height * height)));
        result.Zoom = Math.Clamp(scale / basis, 1, 3);
        result.MoveTo((0.5 - (crop.X + crop.Width / 2)) * result.RenderWidth, (0.5 - (crop.Y + crop.Height / 2)) * result.RenderHeight);
        return result;
    }
}
