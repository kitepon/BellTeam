using Android.App;
using Android.Content.PM;
using Avalonia.Android;

namespace BellTeam.Android;

[Activity(Label = "BellTeam", Theme = "@style/Theme.AppCompat.NoActionBar", MainLauncher = true, ConfigurationChanges = ConfigChanges.Orientation | ConfigChanges.ScreenSize | ConfigChanges.UiMode)]
public class MainActivity : AvaloniaMainActivity { }
