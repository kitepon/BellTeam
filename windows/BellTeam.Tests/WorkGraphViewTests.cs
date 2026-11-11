using System.Windows;
using System.Windows.Automation;
using System.Windows.Automation.Peers;
using System.Windows.Automation.Provider;
using System.Windows.Input;
using System.Windows.Media;
using System.Windows.Media.Imaging;
using System.Windows.Threading;
using BellTeam.App;
using BellTeam.Core;

namespace BellTeam.Tests;

// The 相関図 window and drawing (W-MAC 13b). The model itself is WorkGraphModelTests; the two measuring tests are the ones the Mac keeps in WorkGraphModelTests.swift
// because they need the view's text measurer: testLongLabelWrapsAtSixteenPointLines and testChipTextColumnIsTheSameWhenMeasuredAndDrawn.
public sealed class WorkGraphViewTests
{
    private const double Dpi = 1;

    [Fact]
    public void LongLabelWrapsAtSixteenPointLines()
    {
        var text = string.Concat(Enumerable.Repeat("会話一覧の位置が飛ばないことを確かめる", 4));
        var column = WorkGraphText.TextColumn(180);
        var height = Math.Ceiling(WorkGraphText.Label(text, column, Dpi).Height);
        Assert.True(height > 16 * 3, "a long text takes several lines");
        Assert.Equal(0, height % 16);
        Assert.Equal(16, Math.Ceiling(WorkGraphText.Label("比較表を更新", column, Dpi).Height));
    }

    [Fact]
    public void ChipTextColumnIsTheSameWhenMeasuredAndDrawn()
    {
        foreach (var label in new[] { "比較表を更新", "分身：" + string.Concat(Enumerable.Repeat("会話一覧の位置が飛ばないこと", 5)), "分身：iPhone and Mac screenshots of the work graph chip wrapping at the edge" })
        {
            var size = WorkGraphText.ChipSize(label, 180, Dpi);
            // The drawing wraps at the column of the width it was given; that must give the height the measuring reported.
            var height = Math.Ceiling(WorkGraphText.Label(label, WorkGraphText.TextColumn(size.Width), Dpi).Height);
            Assert.Equal(height + 10, size.Height);
            Assert.True(size.Width <= 180, label);
        }
    }

    [Fact]
    public void OpeningTheGraphTwiceUsesOneWindowAndAClosedOneIsReplaced() => RunSta(() =>
    {
        using var workspace = new Workspace();
        var first = WorkGraphWindow.Open(workspace, _ => Task.CompletedTask);
        Assert.Equal("相関図", first.Title);
        Assert.Same(first, WorkGraphWindow.Open(workspace, _ => Task.CompletedTask));
        first.Close();
        Assert.Null(WorkGraphWindow.Current);
        var second = WorkGraphWindow.Open(workspace, _ => Task.CompletedTask);
        Assert.NotSame(first, second);
        second.Close();
    });

    private static WorkGraphNode Node(string id, string name, string state = "working") => new(id, name, "violet", "", state, null);
    private static WorkGraphEdge Edge(string id, string from, string to, string? label, WorkGraphForkSeat? fork = null) => new(id, null, from, to, label, "running", null, fork);

    private static WorkGraphCanvas Populated(double now = 0, string[]? degraded = null)
    {
        var canvas = new WorkGraphCanvas();
        canvas.Measure(new Size(800, 600)); canvas.Arrange(new Rect(0, 0, 800, 600));
        canvas.Model.Apply(new WorkGraphSnapshot("e", 1, degraded ?? [], [Node("a", "ハル"), Node("b", "ユキ"), Node("c", "ナギ", "linked"), Node("d", "ソラ")],
            [Edge("e1", "b", "a", "比較表を更新"), Edge("e2", "d", "c", null), Edge("e3", "a", "d", "確認して", new WorkGraphForkSeat("f1"))]), now);
        return canvas;
    }

    [Fact]
    public void MembersAndRequestsAreReadAndAMemberCanBeActivated() => RunSta(() =>
    {
        var canvas = Populated(WorkGraphModel.Now);
        var opened = new List<string>();
        canvas.OpenMember = opened.Add;
        var peer = UIElementAutomationPeer.CreatePeerForElement(canvas);
        var children = peer.GetChildren();
        var names = children.Select(child => child.GetName()).ToArray();
        Assert.Equal(["ハル、作業中、0分前から", "ユキ、作業中、0分前から", "ナギ、依頼の相手", "ソラ、作業中、0分前から"], names[..4]);
        // The label is read after a colon; a null label reads only who asked whom; a fork edge reads its 「分身：」 text.
        Assert.Equal(["ユキからハルへ依頼: 比較表を更新", "ソラからナギへ依頼", "ハルからソラへ依頼: 分身：確認して"], names[4..]);
        Assert.Equal("チャットを開く", children[0].GetHelpText());
        var member = (IInvokeProvider)children[2].GetPattern(PatternInterface.Invoke)!;
        member.Invoke();
        Dispatcher.CurrentDispatcher.Invoke(() => { }, DispatcherPriority.Background);
        Assert.Equal(["c"], opened);
        Assert.Null(children[4].GetPattern(PatternInterface.Invoke));
    });

    [Fact]
    public void KeysMoveBetweenMembersAndEnterOrSpaceOpensOne() => RunSta(() =>
    {
        var canvas = Populated(WorkGraphModel.Now);
        var opened = new List<string>();
        canvas.OpenMember = opened.Add;
        Assert.False(canvas.KeyPressed(Key.Enter, false)); // nothing is focused yet
        canvas.FocusMember("a");
        Assert.True(canvas.KeyPressed(Key.Tab, false)); Assert.Equal("b", canvas.FocusedMember);
        Assert.True(canvas.KeyPressed(Key.Left, false)); Assert.Equal("a", canvas.FocusedMember);
        Assert.True(canvas.KeyPressed(Key.Tab, true)); Assert.Equal("d", canvas.FocusedMember); // wraps backwards
        Assert.True(canvas.KeyPressed(Key.Space, false));
        Assert.True(canvas.KeyPressed(Key.Down, false)); Assert.Equal("a", canvas.FocusedMember);
        Assert.True(canvas.KeyPressed(Key.Enter, false));
        Assert.False(canvas.KeyPressed(Key.A, false));
        Assert.Equal(["d", "a"], opened);
    });

    [Fact]
    public void AClickOnAMemberOpensItButAMovedPressOrEmptySpaceDoesNot() => RunSta(() =>
    {
        var canvas = Populated();
        for (var frame = 1; frame <= 5 * 60; frame++) canvas.Frame(frame / 60.0);
        var opened = new List<string>();
        canvas.OpenMember = opened.Add;
        var avatar = canvas.Model.Frames(canvas.Model.Bodies["a"], WorkGraphModel.Now).Avatar;
        GraphPoint centre = new(avatar.MidX, avatar.MidY), away = new(avatar.MidX + 30, avatar.MidY);
        canvas.PressAt(centre); canvas.MoveTo(centre); canvas.ReleaseAt(centre);
        Assert.Equal(["a"], opened);
        canvas.PressAt(centre); canvas.MoveTo(away); canvas.ReleaseAt(away);
        canvas.PressAt(new(1, 1)); canvas.ReleaseAt(new(1, 1));
        canvas.ReleaseAt(centre); // a release without a press is nothing
        Assert.Equal(["a"], opened);
    });

    [Fact]
    public void AFrameDrawsEveryPartAndTheDegradedPillIsShown() => RunSta(() =>
    {
        var canvas = Populated(0, ["queue"]);
        for (var frame = 1; frame <= 12 * 60; frame++) canvas.Frame(frame / 60.0);
        Assert.Equal((null, "一部の情報を取得できていません"), canvas.Status);
        // Every request with a label has its chip placed; the null-label one has none.
        Assert.Equal(2, canvas.Model.Chips.Unblocked.Count + canvas.Model.Chips.Blocked.Count);
        canvas.Measure(new Size(800, 600)); canvas.Arrange(new Rect(0, 0, 800, 600)); canvas.UpdateLayout();
        var bitmap = new RenderTargetBitmap(800, 600, 96, 96, PixelFormats.Pbgra32);
        bitmap.Render(canvas);
        var pixels = new byte[800 * 600 * 4]; bitmap.CopyPixels(pixels, 800 * 4, 0);
        Assert.True(Enumerable.Range(0, pixels.Length / 4).Count(i => pixels[i * 4 + 3] > 0) > 5000, "nodes, lines and chips are drawn");
    });

    [Fact]
    public void AnAvatarsLineColourIsItsVividHueAndAGreyPictureHasNone()
    {
        static BitmapSource Solid(byte red, byte green, byte blue)
        {
            var pixels = Enumerable.Range(0, 16).SelectMany(_ => new byte[] { blue, green, red, 255 }).ToArray();
            return BitmapSource.Create(4, 4, 96, 96, PixelFormats.Bgra32, null, pixels, 16);
        }
        var tone = WorkGraphColors.Representative(Solid(0x30, 0x60, 0xE0))!.Value;
        Assert.True(tone.B > tone.G && tone.G > tone.R, "the hue of the picture is kept");
        Assert.Null(WorkGraphColors.Representative(Solid(0x80, 0x80, 0x80)));
        // The line is darker and the streak lighter than the tone they come from.
        var wire = WorkGraphColors.Wire(tone); var spark = WorkGraphColors.Spark(tone);
        Assert.True(wire.B < tone.B && spark.R > tone.R);
    }

    private static void RunSta(Action action)
    {
        Exception? failure = null;
        var thread = new Thread(() => { try { SynchronizationContext.SetSynchronizationContext(new DispatcherSynchronizationContext(Dispatcher.CurrentDispatcher)); action(); } catch (Exception error) { failure = error; } finally { Dispatcher.CurrentDispatcher.InvokeShutdown(); } });
        thread.SetApartmentState(ApartmentState.STA); thread.Start(); thread.Join();
        if (failure is not null) System.Runtime.ExceptionServices.ExceptionDispatchInfo.Capture(failure).Throw();
    }
}
