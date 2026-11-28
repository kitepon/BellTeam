using System.Text.Json.Serialization;

namespace BellTeam.Core;

public sealed record HarnessCliError(string Code, string Message);

// The server's one fact about an AI CLI (harness-cli.md, a451): the apps show Message as given and never judge the state themselves.
// A server without the field leaves Install null; the app then behaves as before (installed).
public sealed record HarnessCliInstall
{
    // checking | installed | not_installed | installing | failed
    public required string State { get; init; }
    public string? Version { get; init; }
    public string? Source { get; init; }
    public bool Busy { get; init; }
    public HarnessCliError? LastError { get; init; }
    public string Message { get; init; } = "";
    // "install" when a press is possible; null while busy or checking.
    public string? Action { get; init; }
    public string? Label { get; init; }
    public static string DefaultLabel  => CoreStrings.HarnessCliInstall_DefaultLabel_1;
    [JsonIgnore] public bool CanPress => Action == "install";
    [JsonIgnore] public string ButtonLabel => string.IsNullOrEmpty(Label) ? DefaultLabel : Label;
    // 要対応 (Tronie ruling 2026-11-19): only an AI that is not there or whose install failed. installing moves by itself, checking and installed never count, even when the last update failed.
    [JsonIgnore] public bool NeedsAttention => State is "not_installed" or "failed";
    // The CLI cannot run yet and the server has an answer for it (not checking): the screens show the server's sentence and no login.
    // Mac CLIInstallSection: the sentence is orange and the press is the primary button when the AI cannot run or the last install failed.
    [JsonIgnore] public bool Warns => CannotRun || LastError is not null;
    [JsonIgnore] public bool CannotRun => State is "not_installed" or "installing" or "failed";
    // The login buttons are shown only when the AI can run; a server that does not report it (null) is treated as ready.
    public static bool Ready(HarnessCliInstall? install) => install is null || install.State == "installed";
}

public sealed record HarnessCliInstallResponse { public required string Harness { get; init; } public required HarnessCliInstall Install { get; init; } }
