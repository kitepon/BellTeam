using Android.App;
using Android.Runtime;
using Avalonia.Android;

[assembly: UsesPermission(Android.Manifest.Permission.Internet)]

namespace BellTeam.Android;

// LAN servers are plain http (docs/linux-architecture.md: LAN HTTP connections need no login); Android blocks cleartext unless the app says so.
[Application(UsesCleartextTraffic = true)]
public sealed class AndroidApp(IntPtr handle, JniHandleOwnership ownership) : AvaloniaAndroidApplication<App>(handle, ownership) { }
