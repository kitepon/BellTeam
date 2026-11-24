using Android.App;
using Android.Runtime;
using Avalonia.Android;

[assembly: UsesPermission(Android.Manifest.Permission.Internet)]
// Contract 1.36 duty: the local form reaches another device over the same network (LAN) (Android 17 asks for this permission).
[assembly: UsesPermission("android.permission.ACCESS_LOCAL_NETWORK")]

namespace BellTeam.Android;

// LAN servers are plain http (docs/linux-architecture.md: LAN HTTP connections need no login); Android blocks cleartext unless the app says so.
[Application(UsesCleartextTraffic = true)]
public sealed class AndroidApp(IntPtr handle, JniHandleOwnership ownership) : AvaloniaAndroidApplication<App>(handle, ownership) { }
