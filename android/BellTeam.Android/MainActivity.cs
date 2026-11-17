using Android.App;
using Android.Content.PM;
using Android.OS;
using Android.Views;
using Avalonia.Android;

namespace BellTeam.Android;

[Activity(Label = "BellTeam", Theme = "@style/Theme.AppCompat.NoActionBar", MainLauncher = true, WindowSoftInputMode = SoftInput.AdjustResize, ConfigurationChanges = ConfigChanges.Orientation | ConfigChanges.ScreenSize | ConfigChanges.UiMode)]
public class MainActivity : AvaloniaMainActivity
{
    // Play Billing's purchase sheet needs the running Activity.
    public static MainActivity Current { get; private set; } = null!;
    protected override void OnCreate(Bundle? savedInstanceState) { Current = this; base.OnCreate(savedInstanceState); }
}
