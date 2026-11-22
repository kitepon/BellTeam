using Android.App;
using Android.Content;
using Android.Content.PM;
using Android.OS;
using Android.Views;
using Avalonia.Android;

namespace BellTeam.Android;

// Test host only (Bready's test Worker); the production App Link host comes with the production Worker. Auth Tab path of the library's web sign-in return (login-billing 0.11.0).
[IntentFilter([Intent.ActionView], Categories = [Intent.CategoryDefault, Intent.CategoryBrowsable], DataScheme = "https", DataHost = "bellteam-login-test.kitepon.dev", DataPath = "/auth/return/android", AutoVerify = true)]
[Activity(Label = "BellTeam", Theme = "@style/Theme.AppCompat.NoActionBar", MainLauncher = true, LaunchMode = LaunchMode.SingleTop, WindowSoftInputMode = SoftInput.AdjustResize, ConfigurationChanges = ConfigChanges.Orientation | ConfigChanges.ScreenSize | ConfigChanges.UiMode)]
public class MainActivity : AvaloniaMainActivity
{
    public static MainActivity Current { get; private set; } = null!;
    protected override void OnCreate(Bundle? savedInstanceState)
    {
        Current = this; base.OnCreate(savedInstanceState);
        PushChannel.Ensure(this); PushRouter.Accept(Intent);
        // login-billing duty: before the activity starts, so the Auth Tab can hand a web sign-in's return back. Each instance registers its own launcher (contract 1.24); the result returns to the one that opened it.
        AccountStore.Billing?.RegisterWebReturn(this); ApprovalBoxAccount.Billing?.RegisterWebReturn(this);
        // Android 13+ asks before showing any notification.
        if (Build.VERSION.SdkInt >= BuildVersionCodes.Tiramisu && CheckSelfPermission(global::Android.Manifest.Permission.PostNotifications) != Permission.Granted) RequestPermissions([global::Android.Manifest.Permission.PostNotifications], 1);
    }
    protected override void OnNewIntent(Intent? intent) { base.OnNewIntent(intent); if (AccountStore.Billing?.OnWebReturn(intent) != true) ApprovalBoxAccount.Billing?.OnWebReturn(intent); PushRouter.Accept(intent); }
    protected override void OnResume() { base.OnResume(); PushRouter.Foreground = true; _ = AccountStore.StartAsync();
    }
    protected override void OnPause() { PushRouter.Foreground = false; base.OnPause(); }
}
