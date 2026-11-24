using Android.App;
using Android.Content;
using Android.Content.PM;
using Android.OS;
using Android.Views;
using Avalonia.Android;

namespace BellTeam.Android;

[IntentFilter(new[] { Intent.ActionView }, Categories = new[] { Intent.CategoryDefault, Intent.CategoryBrowsable }, DataScheme = "https", DataHost = "login-billing.kitepon.dev", DataPathPrefix = "/join/dev.kitepon.bellbot", AutoVerify = true)]
[Activity(Label = "BellTeam", Theme = "@style/Theme.AppCompat.NoActionBar", MainLauncher = true, LaunchMode = LaunchMode.SingleTop, WindowSoftInputMode = SoftInput.AdjustResize, ConfigurationChanges = ConfigChanges.Orientation | ConfigChanges.ScreenSize | ConfigChanges.UiMode)]
public class MainActivity : AvaloniaMainActivity
{
    public static MainActivity Current { get; private set; } = null!;
    protected override void OnCreate(Bundle? savedInstanceState)
    {
        Current = this; base.OnCreate(savedInstanceState);
        PushChannel.Ensure(this); PushRouter.Accept(Intent); JoinLink.Accept(Intent);
        // login-billing duties: before the activity starts. The local form asks for local network access where Android requires it (contract 1.36); Approval Box's own instance registers the Auth Tab for its web sign-in's return.
        AccountStore.Local?.RegisterLocalNetwork(this); ApprovalBoxAccount.Billing?.RegisterWebReturn(this);
        // Android 13+ asks before showing any notification.
        if (Build.VERSION.SdkInt >= BuildVersionCodes.Tiramisu && CheckSelfPermission(global::Android.Manifest.Permission.PostNotifications) != Permission.Granted) RequestPermissions([global::Android.Manifest.Permission.PostNotifications], 1);
    }
    protected override void OnNewIntent(Intent? intent) { base.OnNewIntent(intent); ApprovalBoxAccount.Billing?.OnWebReturn(intent); PushRouter.Accept(intent); JoinLink.Accept(intent); }
    protected override void OnResume() { base.OnResume(); PushRouter.Foreground = true; AccountStore.NoteForeground();
    }
    protected override void OnPause() { PushRouter.Foreground = false; base.OnPause(); }
}
