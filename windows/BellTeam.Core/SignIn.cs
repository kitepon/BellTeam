namespace BellTeam.Core;

// login-billing (library contract 1.20, design reading 3): every official app signs in itself with Apple or Google through the system browser.
// The sentences are the one table of app-sessions.md 7f (Mika owns it); the part that does the sign-in (the library's C# desktop part, t4k) is wired to SignInView when it is pinned.
public enum SignInPhase { Entry, Waiting, ReturnNotReceived, NotOwner }

public static class SignInText
{
    public const string Title = "BellTeamにサインイン";
    public const string Apple = "Appleでサインイン";
    public const string Google = "Googleでサインイン";
    public const string Note = "ブラウザーが開きます。サインインが終わると、このアプリに戻ります。";
    public const string Waiting = "ブラウザーでサインインしています…";
    public const string Cancel = "やめる";
    public const string ReturnNotReceived = "サインインの結果がこのアプリに届きませんでした。このパソコン自身のブラウザーで、もう一度サインインしてください。";
    public const string NotOwner = "このサーバーの持ち主のアカウントではないため、ログインできませんでした。";
    public const string SetupCodeLabel = "セットアップコード";
    public const string SetupCodeInvalid = "セットアップコードが正しくないか、期限が切れています。サーバーに出ている新しいコードを入れてください。";
    public const string SetupCodeRequired = "このサーバーには、サーバーに出ているセットアップコードが要ります。";
    // app-sessions.md 7f (Mika), as written.
    public const string AddressNotRegistered = "このサーバーは、この接続先を登録していません。サーバーのコンソールで追加するか、すでに入っているアプリから「いまの接続先を追加」してください。";
    public const string ServerNotReady = "サーバーの準備中です。";
    public const string Connecting = "つないでいます…";
    public const string SetupCodeHint = "このサーバーのコンソールに出ているコードを入れてください。最初の1回だけ使います。";
}
