namespace BellTeam.Core;

// login-billing (library contract 1.20, design reading 3): every official app signs in itself with Apple or Google through the system browser.
// The sentences are the one table of app-sessions.md 7f (Mika owns it); the part that does the sign-in (the library's C# desktop part, t4k) is wired to SignInView when it is pinned.
public enum SignInPhase { Entry, Waiting, ReturnNotReceived, NotOwner }

public static class SignInText
{
    public static string Title  => CoreStrings.SignIn_Title_1;
    public static string Apple  => CoreStrings.SignIn_Apple_1;
    public static string Google  => CoreStrings.SignIn_Google_1;
    public static string Note  => CoreStrings.SignIn_Note_1;
    public static string Waiting  => CoreStrings.SignIn_Waiting_1;
    public static string Cancel  => CoreStrings.AccountDeletionText_ConfirmNo_1;
    public static string ReturnNotReceived  => CoreStrings.SignIn_ReturnNotReceived_1;
    public static string NotOwner  => CoreStrings.AppLogin_RefusedText_1;
    public static string SetupCodeLabel  => CoreStrings.SignIn_SetupCodeLabel_1;
    public static string SetupCodeInvalid  => CoreStrings.SignIn_SetupCodeInvalid_1;
    public static string SetupCodeRequired  => CoreStrings.SignIn_SetupCodeRequired_1;
    // app-sessions.md 7f (Mika), as written.
    public static string AddressNotRegistered  => CoreStrings.SignIn_AddressNotRegistered_1;
    public static string ServerNotReady  => CoreStrings.SignIn_ServerNotReady_1;
    public static string Connecting  => CoreStrings.ChildJoin_Joining_1;
    public static string SetupCodeHint  => CoreStrings.SignIn_SetupCodeHint_1;
}
