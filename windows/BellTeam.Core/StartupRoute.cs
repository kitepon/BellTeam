namespace BellTeam.Core;

// The Mac RootView phases. Ready is the workspace; every other phase is a full-window screen.
public enum StartupPhase { Checking, Failure, Setup, Onboarding, SignIn, Ready }

public static class StartupRoute
{
    // Mac AppStore.bootstrap: no saved server shows the server entry, a saved one is checked first.
    public static StartupPhase Initial(string? savedServer) => string.IsNullOrWhiteSpace(savedServer) ? StartupPhase.Setup : StartupPhase.Checking;
    // Mac bootstrap/loadInitialState: a login need wins over a failure; a server whose first setup is unfinished goes to onboarding.
    // A connected server whose setup could not be read (setup is null) is a failure too.
    public static StartupPhase AfterConnect(bool needsLogin, bool connected, SetupState? setup)
        => needsLogin ? StartupPhase.SignIn : !connected || setup is null ? StartupPhase.Failure : setup.Phase == "ready" ? StartupPhase.Ready : StartupPhase.Onboarding;
}
