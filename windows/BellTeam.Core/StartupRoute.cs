namespace BellTeam.Core;

// The Mac RootView phases. Ready is the workspace; every other phase is a full-window screen.
public enum StartupPhase { Checking, Failure, Setup, Onboarding, SignIn, Paywall, Account, Ready }

public static class StartupRoute
{
    // a487, app-sessions.md 7d: the first screen is sign-in and the account, never the server address. No pass, or no saved server, opens the account step (the server step is entered from it); a signed-in app with a saved server checks it first.
    public static StartupPhase Initial(string? savedServer, bool signedIn) => !signedIn || string.IsNullOrWhiteSpace(savedServer) ? StartupPhase.Account : StartupPhase.Checking;
    // Mac bootstrap/loadInitialState: a login need wins over a failure; a server whose first setup is unfinished goes to onboarding.
    // A connected server whose setup could not be read (setup is null) is a failure too.
    // a485 7e: a server whose own entitlement is "none" shows the paywall instead of the app (SubscriptionApi.PaywalledAsync); it comes before onboarding and the workspace.
    public static StartupPhase AfterConnect(bool needsLogin, bool connected, SetupState? setup, bool paywalled = false)
        => needsLogin ? StartupPhase.SignIn : !connected || setup is null ? StartupPhase.Failure : paywalled ? StartupPhase.Paywall : setup.Phase == "ready" ? StartupPhase.Ready : StartupPhase.Onboarding;
}
