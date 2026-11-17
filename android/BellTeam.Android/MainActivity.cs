using Android.App;
using Android.Content.PM;
using Android.Views;
using Avalonia.Android;

namespace BellTeam.Android;

[Activity(Label = "BellTeam", Theme = "@style/Theme.AppCompat.NoActionBar", MainLauncher = true, WindowSoftInputMode = SoftInput.AdjustResize, ConfigurationChanges = ConfigChanges.Orientation | ConfigChanges.ScreenSize | ConfigChanges.UiMode)]
public class MainActivity : AvaloniaMainActivity { }
