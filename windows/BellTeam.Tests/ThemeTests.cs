using System.Windows;
using System.Windows.Media;
using BellTeam.App;

namespace BellTeam.Tests;

public sealed class ThemeTests
{
    // AppsUseLightTheme: 0 is dark; 1, a missing value or anything unexpected is light.
    [Theory]
    [InlineData(0, true)] [InlineData(1, false)] [InlineData(2, false)] [InlineData(null, false)] [InlineData("0", false)]
    public void RegistryValueResolvesToTheAppMode(object? value, bool dark) => Assert.Equal(dark, AppTheme.IsDark(value));

    [Fact]
    public void SwitchingTheModeUpdatesTheBrushesAndTheInstalledResources()
    {
        var resources = new ResourceDictionary(); Palette.Install(resources);
        var card = Assert.IsType<SolidColorBrush>(Palette.Card);
        try
        {
            Assert.Equal(Color.FromRgb(0xFF, 0xFF, 0xFF), card.Color); Assert.Equal(Color.FromRgb(0xFF, 0xFF, 0xFF), Assert.IsType<SolidColorBrush>(resources["Card"]).Color);
            Palette.Apply(true);
            Assert.True(Palette.IsDark);
            Assert.Equal(Color.FromRgb(0x1C, 0x1C, 0x1E), card.Color);
            Assert.Equal(Color.FromRgb(0x1C, 0x1C, 0x1E), Assert.IsType<SolidColorBrush>(resources["Card"]).Color);
            Assert.Equal(Color.FromRgb(0xFF, 0xFF, 0xFF), Assert.IsType<SolidColorBrush>(Palette.Ink).Color);
            Assert.Equal(Color.FromRgb(0x1E, 0x1A, 0x33), Assert.IsType<LinearGradientBrush>(resources["ConversationBackground"]).GradientStops[0].Color);
            Palette.Apply(false);
            Assert.Equal(Color.FromRgb(0xFF, 0xFF, 0xFF), card.Color); Assert.Equal(Color.FromRgb(0x21, 0x29, 0x3D), Assert.IsType<SolidColorBrush>(resources["Ink"]).Color);
        }
        finally { Palette.Apply(false); }
    }

    [Fact]
    public void TheAppPaletteIsTheSameInBothModes()
    {
        try
        {
            var violet = Assert.IsType<SolidColorBrush>(Palette.Get("Violet")).Color; var mint = Assert.IsType<SolidColorBrush>(Palette.Get("Mint")).Color;
            Palette.Apply(true);
            Assert.Equal(violet, Assert.IsType<SolidColorBrush>(Palette.Get("Violet")).Color); Assert.Equal(mint, Assert.IsType<SolidColorBrush>(Palette.Get("Mint")).Color);
        }
        finally { Palette.Apply(false); }
    }

    [Fact]
    public void AnUnknownKeyIsAnError() => Assert.Throws<KeyNotFoundException>(() => Palette.Get("NoSuchColour"));
}
