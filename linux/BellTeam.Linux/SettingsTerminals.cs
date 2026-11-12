using Avalonia.Controls;
using BellTeam.Core;

namespace BellTeam.Linux;

// 設定「端末」: the registry list in the pane, a terminal's detail as a sub page. The editor and the host-key sheet open in the window's sheet.
public sealed partial class SettingsWindow
{
    private TerminalDetailView? terminalDetail;
    internal TerminalDetailView? TerminalDetail => terminalDetail;

    private async Task TerminalsPageAsync(CancellationToken token)
    {
        var page = NewPage(SettingsPage.Terminals);
        var model = workspace.Terminals;
        var list = new TerminalListView(model, OpenTerminal, OpenTerminalEditor);
        page.Children.Add(list);
        void Changed() => list.Render();
        model.Changed += Changed; token.Register(() => model.Changed -= Changed);
        await model.RefreshAsync(token);
    }

    internal void OpenTerminal(string id)
    {
        var view = new TerminalDetailView(workspace, id, lifetime?.Token ?? Token); terminalDetail = view;
        ShowSubPage(id, view, Reopen);
        toolbarRight.Content = view.EditButton;
    }

    private void OpenTerminalEditor()
    {
        if (TopLevel.GetTopLevel(pane) is not ISheetHost host) { workspace.ReportActionError("この画面では開けません。"); return; }
        var view = new TerminalEditorView(workspace, workspace.Terminals, null) { Closer = host.CloseSheet };
        host.OpenSheet("端末を追加", view);
    }
}

// 16c (このPCを追加 / このPCを確かめる) reads the Windows OpenSSH host-key path, so Linux owns no host: no automatic attestation runs and the two rows are not offered.
internal sealed class NoThisPc : IThisPc
{
    public IReadOnlyList<PcInterface> Interfaces() => [];
    public string MachineName => Environment.MachineName;
    public string UserName => Environment.UserName;
    public string UserDomain => Environment.UserDomainName;
    public Task<OpenSshState> OpenSshAsync(int port, CancellationToken token) => Task.FromResult(OpenSshState.Unknown);
    public Task<string> ReadHostKeyAsync(CancellationToken token) => throw new NotSupportedException("このPCのホスト鍵はLinux版では読みません。");
}
