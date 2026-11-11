using System.IO;
using System.Windows;
using System.Windows.Media;
using System.Windows.Media.Imaging;
using BellTeam.Core;

namespace BellTeam.App;

public partial class App : Application
{
    private SingleInstance? instance;
    protected override async void OnStartup(StartupEventArgs e)
    {
        base.OnStartup(e);
        // Renders are screenshots taken right after layout; the card entrance animation would leave cards transparent.
        if (e.Args.Any(argument => argument.StartsWith("--render", StringComparison.Ordinal))) MessageEntrance.Enabled = false;
        try
        {
            if (e.Args is ["--smoke-test", var address, var result])
            {
                Shutdown(await SmokeTest.RunAsync(address, result));
                return;
            }
            if (e.Args is ["--configure", var server])
            {
                var store = new SettingsStore(SettingsStore.UserDirectory);
                var configuration = store.Load(); var origin = ServerOrigin.Parse(server);
                if (configuration.ServerUrl is { } previous && previous != origin.AbsoluteUri) await new DesktopAccess().SignOutAsync();
                store.Save(configuration with { ServerUrl = origin.AbsoluteUri });
                Shutdown(0);
                return;
            }
            if (e.Args is ["--install-shortcut"])
            {
                DesktopShortcut.Create(Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.Programs), "BellTeam.lnk"), Environment.ProcessPath!); Shutdown(0); return;
            }
            if (e.Args is ["--render-gallery", var galleryAddress, var galleryId, var galleryOutput])
            {
                using var galleryWorkspace = new Workspace(); await galleryWorkspace.ConnectAsync(galleryAddress,listen:false);
                if (galleryWorkspace.ConnectionError is { } failure) throw new BellApiException(failure);
                var target = galleryWorkspace.Entries.Single(item=>item.Target.Id==galleryId); await galleryWorkspace.SelectAsync(target);
                var paths = galleryWorkspace.Messages.SelectMany(item=>item.Message.DisplayedImageUrls).Distinct().ToArray();
                if (paths.Length==0) throw new BellApiException("表示する画像がありません。");
                var galleryWindow = new MainWindow(galleryWorkspace, persistPlacement: false); var gallery = galleryWindow.ShowGallery(paths, 0); await gallery.ReadyTask;
                WritePng(galleryWindow, 1280, 820, galleryOutput); galleryWindow.Close(); Shutdown(0); return;
            }
            if (e.Args is ["--render-editor", var editorKind, var editorAddress, var editorId, var editorOutput])
            {
                using var editorWorkspace = new Workspace(); await editorWorkspace.ConnectAsync(editorAddress, listen: false);
                if (editorWorkspace.ConnectionError is { } connectionError) throw new BellApiException(connectionError);
                if (editorKind == "member")
                {
                    var memberWindow = new MemberEditorWindow(editorWorkspace, editorId); await memberWindow.InitializeAsync(); await memberWindow.View.ReadyTask;
                    WritePng(memberWindow, (int)memberWindow.Width, (int)memberWindow.Height, editorOutput); memberWindow.Close(); Shutdown(0); return;
                }
                EditorWindow editor;
                if (editorKind is "settings" or "profile") { var settingsEditor = new SettingsWindow(editorWorkspace) { Width = 960, Height = 800 }; editor = settingsEditor; await settingsEditor.InitializeAsync(SettingsPage.Profile); }
                else if (editorKind == "feature") { var feature = new FeatureEditor(editorWorkspace, editorId, "追加機能"); editor = feature; await feature.InitializeAsync(); }
                else if (editorKind == "authentication") { var option = (await new HarnessAuthenticationApi(editorWorkspace.Management.Api).ListAsync(editorWorkspace.ConnectionToken)).Harnesses.Single(item => item.Id == editorId); var authentication = new HarnessAuthenticationWindow(editorWorkspace, option); editor = authentication; await authentication.InitializeAsync(); }
                else throw new ArgumentException("未対応の編集画面です。");
                await editor.ReadyTask; WritePng(editor, (int)editor.Width, (int)editor.Height, editorOutput); editor.Close(); Shutdown(0); return;
            }
            if (e.Args is ["--render-editors", var editorScene, var sceneAddress, var sceneId, var sceneOutput])
            {
                // The member and room editors in named states, read from the mock server (GET only). Delete and save states are set through render seams, never sent.
                var model = new Workspace(); var window = new MainWindow(model, persistPlacement: false);
                await model.ConnectAsync(sceneAddress, listen: false);
                if (model.ConnectionError is { } connectFailure) throw new BellApiException(connectFailure);
                if (model.Entries.FirstOrDefault(entry => entry.Target.Id == sceneId) is { } behind) await model.SelectAsync(behind);
                if (editorScene.StartsWith("member", StringComparison.Ordinal))
                {
                    if (editorScene == "member-delete-pending") model.SetBotDeletionPendingForRender(sceneId);
                    var memberWindow = window.CreateMemberWindowForRender(sceneId); await memberWindow.InitializeAsync(); await memberWindow.View.ReadyTask;
                    if (editorScene == "member-delete-unconfirmed") memberWindow.View.ShowDeletionUnconfirmedForRender();
                    if (editorScene == "member-delete-alert") memberWindow.View.AskDelete();
                    if (editorScene is "member-delete-pending" or "member-delete-unconfirmed") { var memberRoot = (FrameworkElement)memberWindow.Content; memberRoot.Measure(new Size(1120, 900)); memberRoot.Arrange(new Rect(0, 0, 1120, 900)); memberRoot.UpdateLayout(); memberWindow.View.ScrollToEndForRender(); }
                    WritePng(memberWindow, 1120, 900, sceneOutput); memberWindow.Close(); model.Dispose(); Shutdown(0); return;
                }
                if (editorScene.StartsWith("folder-", StringComparison.Ordinal))
                {
                    // 16b 端末とフォルダ: the picker over an existing member's window, or the new-member sheet with a terminal chosen. Reads are GETs; the terminal choice,
                    // the picker's place and a refused save are set through seams, never sent.
                    var picking = editorScene.StartsWith("folder-picker", StringComparison.Ordinal);
                    MemberEditorView folderView; Window folderWindow;
                    if (picking) { var memberWindow = window.CreateMemberWindowForRender(sceneId); await memberWindow.InitializeAsync(); await memberWindow.View.ReadyTask; (folderWindow, folderView) = (memberWindow, memberWindow.View); }
                    else { window.ShowMemberSheet(); await window.PageReady; (folderWindow, folderView) = (window, (MemberEditorView)window.OpenEditor!); await folderView.ImagesReady; }
                    var (width, height) = picking ? (1120, 900) : (1280, 820);
                    var folderRoot = (FrameworkElement)folderWindow.Content; folderRoot.Measure(new Size(width, height)); folderRoot.Arrange(new Rect(0, 0, width, height)); folderRoot.UpdateLayout();
                    if (!picking)
                    {
                        folderView.ChooseTerminalForRender("ハル", editorScene == "folder-new-windows" ? "fox" : "owner-macbook");
                        if (editorScene == "folder-new-typed") { await folderView.OpenPickerForRender(null); folderView.ClosePickerForRender(); }
                        if (editorScene == "folder-new-missing") folderView.ShowFolderRefusalForRender("FOLDER_MISSING");
                        folderRoot.UpdateLayout();
                        if (editorScene == "folder-new-missing") folderView.ScrollToEndForRender(); else folderView.ShowTerminalSectionForRender();
                    }
                    else await folderView.OpenPickerForRender(editorScene switch { "folder-picker-sub" => "/Users/kite/work", "folder-picker-created" => "/Users/kite/work/scratch", _ => null });
                    folderRoot.UpdateLayout();
                    if (folderWindow == window) await window.PrepareRenderAsync();
                    WritePng(folderWindow, width, height, sceneOutput); folderWindow.Close(); model.Dispose(); Shutdown(0); return;
                }
                if (editorScene is "new-member") window.ShowMemberSheet();
                else if (editorScene is "new-room") window.ShowRoomSheet(null);
                else if (editorScene is "room" or "room-delete-alert") window.ShowRoomSheet(sceneId);
                else if (editorScene == "crop") { window.ShowCropForRender(SplitSwatch(), AvatarVariant.Small); }
                else throw new ArgumentException("未対応の編集画面です。");
                await window.PageReady;
                if (editorScene == "room-delete-alert" && window.OpenEditor is RoomEditorView roomView) roomView.AskDelete();
                if (window.OpenEditor is MemberEditorView created) await created.ImagesReady;
                var sceneRoot = (FrameworkElement)window.Content;
                sceneRoot.Measure(new Size(1280, 820)); sceneRoot.Arrange(new Rect(0, 0, 1280, 820)); sceneRoot.UpdateLayout();
                await window.PrepareRenderAsync();
                WritePng(window, 1280, 820, sceneOutput);
                model.Dispose(); Shutdown(0); return;
            }
            if (e.Args is ["--render-schedules", var scheduleScene, var scheduleAddress, var scheduleOutput])
            {
                // The schedule page and its sheets in named states, read from the mock server (GET only). The weekly error is a validation that stops before any request.
                var model = new Workspace(); var window = new MainWindow(model, persistPlacement: false);
                await model.ConnectAsync(scheduleAddress, listen: false);
                if (model.ConnectionError is { } connectFailure) throw new BellApiException(connectFailure);
                window.ShowSchedules(); await window.PageReady;
                var page = window.SchedulesPage ?? throw new BellApiException("予定のページを開けませんでした。");
                switch (scheduleScene)
                {
                    case "list" or "empty" or "failed": break;
                    case "delete": page.AskDeleteForRender(); break;
                    case "editor-member": page.OpenEditorForRender().Prefill(nameText: "朝の確認", text: "今日の予定と優先事項を整理して、先に知らせてほしい。"); break;
                    case "editor-room": page.OpenEditorForRender().Prefill(ownerPath: new ChatTarget("planning", true).Path, nameText: "週のふり返り", text: "進んだ仕事をまとめる", frequencyId: "daily"); break;
                    case "editor-weekly-error": { var view = page.OpenEditorForRender("weekly"); view.Prefill(frequencyId: "weekly", weekdays: []); await view.SaveAsync(); break; }
                    case "editor-interval": page.OpenEditorForRender().Prefill(nameText: "巡回", text: "python3 tools/patrol.py", frequencyId: "interval_hours"); break;
                    default: throw new ArgumentException("未対応の予定の画面です。");
                }
                await window.PageReady;
                var scheduleRoot = (FrameworkElement)window.Content;
                scheduleRoot.Measure(new Size(1280, 820)); scheduleRoot.Arrange(new Rect(0, 0, 1280, 820)); scheduleRoot.UpdateLayout();
                if (scheduleScene == "editor-weekly-error") page.Editor!.ScrollToEndForRender();
                await window.PrepareRenderAsync();
                WritePng(window, 1280, 820, scheduleOutput);
                model.Dispose(); Shutdown(0); return;
            }
            if (e.Args is ["--render-page", var pageKind, var pageAddress, var pageOutput])
            {
                using var pageWorkspace = new Workspace(); await pageWorkspace.ConnectAsync(pageAddress, listen: false);
                if (pageWorkspace.ConnectionError is { } failure) throw new BellApiException(failure);
                var pageWindow = new MainWindow(pageWorkspace, persistPlacement: false, notifications: new DesktopNotifications(new WindowsNotificationSink(), new SettingsStore(SettingsStore.UserDirectory), (_, _) => { }));
                if (pageKind is "settings" or "settings-lower") pageWindow.ShowSettings(); else if (pageKind.StartsWith("settings-", StringComparison.Ordinal) && Enum.TryParse<SettingsPage>(pageKind["settings-".Length..], ignoreCase: true, out var settingsPage)) pageWindow.ShowSettings(settingsPage); else if (pageKind == "schedules") pageWindow.ShowSchedules(); else if (pageKind == "goals") pageWindow.ShowGoals(); else if (pageKind is "updates" or "updates-current" or "updates-narrow" or "updates-detail-narrow") pageWindow.ShowSettings(SettingsPage.Update); else if (pageKind == "update-sheet") { if (pageWorkspace.Entries.FirstOrDefault() is { } behind) await pageWorkspace.SelectAsync(behind); pageWindow.ShowUpdateSheet(); } else if (pageKind.StartsWith("onepassword-", StringComparison.Ordinal)) pageWindow.ShowSettings(SettingsPage.Features); else throw new ArgumentException("未対応のページです。");
                await pageWindow.PageReady;
                if (pageKind.StartsWith("onepassword-", StringComparison.Ordinal)) await (pageWindow.SettingsPageWindow ?? throw new BellApiException("設定を開けませんでした。")).OpenOnePasswordForRender(pageKind["onepassword-".Length..]);
                var pageWidth = pageKind is "updates-narrow" or "updates-detail-narrow" ? 1100 : 1280; var pageHeight = pageKind is "updates-narrow" or "updates-detail-narrow" ? 700 : 820;
                var pageRoot = (FrameworkElement)pageWindow.Content; pageRoot.Measure(new Size(pageWidth, pageHeight)); pageRoot.Arrange(new Rect(0, 0, pageWidth, pageHeight)); pageRoot.UpdateLayout();
                if (pageKind == "updates-detail-narrow") { FindExpander(pageRoot).IsExpanded = true; pageRoot.UpdateLayout(); }
                await pageWindow.PrepareRenderAsync(bottomOfPage: pageKind is "settings-lower" or "updates-detail-narrow"); WritePng(pageWindow, pageWidth, pageHeight, pageOutput); pageWindow.Close(); Shutdown(0); return;
            }
            if (e.Args is ["--render-terminals", var terminalScene, var terminalAddress, var terminalOutput])
            {
                // 設定「端末」 in named states, read from the mock server (GET only). What follows a check or a write is set through render seams, never sent.
                using var terminalWorkspace = new Workspace(); await terminalWorkspace.ConnectAsync(terminalAddress, listen: false);
                if (terminalWorkspace.ConnectionError is { } terminalFailure) throw new BellApiException(terminalFailure);
                var terminalWindow = new MainWindow(terminalWorkspace, persistPlacement: false);
                terminalWindow.ShowSettings(SettingsPage.Terminals); await terminalWindow.PageReady;
                var settingsPage = terminalWindow.SettingsPageWindow!; var terminals = terminalWorkspace.Terminals;
                var terminalId = terminalScene.StartsWith("editor", StringComparison.Ordinal) ? "" : terminals.Terminals.First().TerminalId;
                var observed = DateTimeOffset.Now.AddMinutes(-3).ToString("o");
                TerminalCheck Failed(string reason, string? action) => new() { TerminalId = terminalId, Reachable = false, Reason = reason, Action = action, ObservedAt = observed };
                if (terminalScene.StartsWith("editor", StringComparison.Ordinal))
                {
                    var editor = new TerminalEditorView(terminalWorkspace, terminals, null) { Closer = terminalWindow.CloseUpdateSheet };
                    editor.OsPicker.SelectedValue = terminalScene["editor-".Length..];
                    terminalWindow.OpenSheet("端末を追加", editor);
                }
                else if (terminalScene != "list")
                {
                    settingsPage.OpenTerminal(terminalId);
                    switch (terminalScene)
                    {
                        case "detail-auth-failed": terminals.Checks[terminalId] = Failed("AUTH_FAILED", "この鍵がまだMacに入っていないかもしれません。「このMacにこの鍵を入れる」で、Macのログインパスワードを使って入れられます"); break;
                        case "detail-windows": terminals.Checks[terminalId] = Failed("CONNECTION_REFUSED", null); break;
                        case "detail-authorizing": terminals.Checks[terminalId] = Failed("AUTH_FAILED", null); terminals.Authorizations[terminalId] = new AuthorizeState.Waiting("r1", false); break;
                        case "detail-hostkey": case "hostkey-sheet": terminals.Checks[terminalId] = Failed("TARGET_MISMATCH", "confirm the new host key SHA256:nsffMHVAtGXV6+uEQqXTTMcNxrINQqErir/1ZI1Ch/Y on office-imac.local"); break;
                    }
                    terminals.Notify();
                    if (terminalScene == "detail-hostkey") settingsPage.TerminalDetail!.OtherWaysOpen = true;
                    if (terminalScene == "hostkey-sheet") terminalWindow.OpenSheet("ホスト鍵", new HostKeyView(terminalWorkspace, terminals, terminals.Find(terminalId)!, terminals.Checks[terminalId]) { Closer = terminalWindow.CloseUpdateSheet });
                }
                var terminalRoot = (FrameworkElement)terminalWindow.Content; terminalRoot.Measure(new Size(1280, 820)); terminalRoot.Arrange(new Rect(0, 0, 1280, 820)); terminalRoot.UpdateLayout();
                await terminalWindow.PrepareRenderAsync(bottomOfPage: terminalScene.StartsWith("keys", StringComparison.Ordinal)); WritePng(terminalWindow, 1280, 820, terminalOutput); terminalWindow.Close(); Shutdown(0); return;
            }
            if (e.Args is ["--render-conversation", var scene, var conversationAddress, var sceneConversationId, var conversationOutput])
            {
                // A conversation in a named state, read from the mock server (GET only). The failed scene is meant to fail its first read.
                var model = new Workspace(); var window = new MainWindow(model, persistPlacement: false);
                await model.ConnectAsync(conversationAddress, listen: false);
                if (model.ConnectionError is { } connectFailure) throw new BellApiException(connectFailure);
                await model.SelectAsync(model.Entries.FirstOrDefault(entry => entry.Target.Id == sceneConversationId) ?? throw new BellApiException("指定した会話がありません。"));
                if (scene != "failed" && model.ConnectionError is { } readFailure) throw new BellApiException(readFailure);
                if (scene is not ("member" or "room")) window.HideInspectorForRender();
                if (scene == "draft") { model.AttachClipboardImage(Swatch(0x0A, 0x84, 0xFF)); model.AttachClipboardImage(Swatch(0xE8, 0x6B, 0x94)); model.DraftText = "この画像も見てほしい。"; }
                if (scene == "stop-notice") model.StopResult = StopNotice.Sent;
                if (scene == "echo") { model.ShowEchoForRender("続きはあとで確認するね。", accepted: true); model.ShowEchoForRender("ありがとう、助かったよ。", accepted: false); }
                if (scene == "peer-sheet") window.ShowPeerSheet(model.Messages.Select(item => item.Message).First(item => item.Kind == "peer"));
                var conversationHeight = scene == "states" ? 1300 : scene == "stack" ? 1500 : 820;
                var conversationRoot = (FrameworkElement)window.Content;
                conversationRoot.Measure(new Size(1280, conversationHeight)); conversationRoot.Arrange(new Rect(0, 0, 1280, conversationHeight)); conversationRoot.UpdateLayout();
                await window.PrepareRenderAsync();
                WritePng(window, 1280, conversationHeight, conversationOutput);
                model.Dispose(); Shutdown(0); return;
            }
            if (e.Args is ["--render-inspector", var inspectorScene, var inspectorAddress, var inspectorId, var inspectorOutput])
            {
                // The inspector (and its image sheets) read from the mock server (GET only); no save is ever sent.
                var model = new Workspace(); var window = new MainWindow(model, persistPlacement: false);
                await model.ConnectAsync(inspectorAddress, listen: false);
                if (model.ConnectionError is { } connectFailure) throw new BellApiException(connectFailure);
                await model.SelectAsync(model.Entries.FirstOrDefault(entry => entry.Target.Id == inspectorId) ?? throw new BellApiException("指定した会話がありません。"));
                if (inspectorScene is "restart-busy" or "restart-success") window.ProfilePanel.SetRestartForRender(inspectorId, inspectorScene == "restart-busy");
                if (inspectorScene.StartsWith("pending", StringComparison.Ordinal))
                {
                    var swatch = Swatch(0xE8, 0x6B, 0x94);
                    model.ImageSession(inspectorId).Keep(AvatarVariant.Large, new AvatarSelection(AvatarCropView.Encode(swatch, new AvatarCrop(swatch.PixelWidth, swatch.PixelHeight, 1024)), "data:image/jpeg;base64,/9j/", new AvatarCropRect(0, 0, 1, 1)), BotProfileText.Unconfirmed(new BellApiException("接続が切れました。")));
                }
                AvatarActionsView? sheet = inspectorScene switch { "sheet-small" => window.ShowAvatarSheetForRender(AvatarVariant.Small), "sheet-large" or "sheet-unsupported" or "pending-sheet" => window.ShowAvatarSheetForRender(AvatarVariant.Large), _ => null };
                if (inspectorScene == "sheet-unsupported" && sheet is not null) await sheet.LoadSettingsAsync();
                if (sheet is not null) await sheet.Ready;
                var inspectorHeight = sheet is null ? 1300 : 820;
                var inspectorRoot = (FrameworkElement)window.Content;
                inspectorRoot.Measure(new Size(1280, inspectorHeight)); inspectorRoot.Arrange(new Rect(0, 0, 1280, inspectorHeight)); inspectorRoot.UpdateLayout();
                await window.PrepareRenderAsync();
                WritePng(window, 1280, inspectorHeight, inspectorOutput);
                model.Dispose(); Shutdown(0); return;
            }
            if (e.Args is ["--render-goals", var goalScene, var goalAddress, var goalBotId, var goalOutput])
            {
                // The goal pill and editor sheet read from the mock server (GET only). A save used for the validation scene stops before any request.
                var model = new Workspace(); var window = new MainWindow(model, persistPlacement: false);
                await model.ConnectAsync(goalAddress, listen: false);
                if (model.ConnectionError is { } connectFailure) throw new BellApiException(connectFailure);
                await model.SelectAsync(model.Entries.FirstOrDefault(entry => entry.Target.Id == goalBotId) ?? throw new BellApiException("指定した会話がありません。"));
                window.HideInspectorForRender();
                await window.GoalBar.LoadTask;
                if (goalScene == "pill-open") window.GoalBar.SetExpanded(true);
                if (goalScene is "editor-create" or "editor-edit")
                {
                    var editor = window.GoalBar.OpenEditorForRender(goalScene == "editor-create" ? "create" : "edit") ?? throw new BellApiException("ゴールを読み取れませんでした。");
                    if (goalScene == "editor-create") { editor.SetForRender("新機能の設計をまとめる", "abc"); await editor.SaveAsync(); }
                }
                var goalRoot = (FrameworkElement)window.Content;
                goalRoot.Measure(new Size(1280, 820)); goalRoot.Arrange(new Rect(0, 0, 1280, 820)); goalRoot.UpdateLayout();
                await window.PrepareRenderAsync();
                WritePng(window, 1280, 820, goalOutput);
                model.Dispose(); Shutdown(0); return;
            }
            if (e.Args is ["--render-screen", var screenScene, var screenAddress, var screenId, var screenOutput])
            {
                // The Bot screen read from the mock server (GET only). States that need a POST result are set through render seams, never sent.
                var model = new Workspace(); var window = new MainWindow(model, persistPlacement: false);
                await model.ConnectAsync(screenAddress, listen: false);
                if (model.ConnectionError is { } connectFailure) throw new BellApiException(connectFailure);
                await model.SelectAsync(model.Entries.FirstOrDefault(entry => entry.Target.Id == screenId) ?? throw new BellApiException("指定した会話がありません。"));
                var opened = model.OpenScreenAsync();
                await model.ScreenFirstRead.WaitAsync(TimeSpan.FromSeconds(10));
                if (screenScene == "digits") { window.ScreenPanel.OpenDigitsForRender(); model.ScreenInput!.SetNoticeForRender("席が起動していません"); }
                if (screenScene == "sent") window.ScreenPanel.ShowSentForRender("Enter");
                var screenRoot = (FrameworkElement)window.Content;
                screenRoot.Measure(new Size(1280, 820)); screenRoot.Arrange(new Rect(0, 0, 1280, 820)); screenRoot.UpdateLayout();
                window.ScreenPanel.FollowBottomForRender();
                await window.PrepareRenderAsync();
                WritePng(window, 1280, 820, screenOutput);
                model.ReturnToProfile(); await opened;
                model.Dispose(); Shutdown(0); return;
            }
            if (e.Args is ["--render-startup", var startupScene, var startupAddress, var startupOutput])
            {
                // The startup screens read from the mock server (GET only). The routing is the real one: the mock answers the session and setup the scene needs.
                var model = new Workspace(); var window = new MainWindow(model, persistPlacement: false) { AutoRetry = false };
                StartupPhase? expected = startupScene switch { "opening" => StartupPhase.Checking, "setup" or "guide" => StartupPhase.Setup, "failure" => StartupPhase.Failure, "login" => StartupPhase.SignIn, "onboarding-choose" or "onboarding-waiting" => StartupPhase.Onboarding, "banner" => StartupPhase.Ready, _ => null };
                if (expected is null) throw new ArgumentException("未対応の起動画面です。");
                if (startupScene == "opening") window.ShowOpeningForRender();
                else if (startupScene is "setup" or "guide") { window.ShowServerSetup(); if (startupScene == "guide") window.ShowServerGuide(); }
                else await window.ConnectAsync(startupAddress, openLogin: false);
                if (window.Startup != expected) throw new BellApiException($"起動画面が想定と違います: {window.Startup}");
                if (startupScene == "banner") model.SetConnectionErrorForRender("更新の接続が切れました。再接続しています。");
                var startupRoot = (FrameworkElement)window.Content;
                startupRoot.Measure(new Size(1280, 820)); startupRoot.Arrange(new Rect(0, 0, 1280, 820)); startupRoot.UpdateLayout();
                await window.PrepareRenderAsync();
                WritePng(window, 1280, 820, startupOutput);
                model.Dispose(); Shutdown(0); return;
            }
            if (e.Args is ["--render-secret", var secretScene, var secretAddress, var secretOutput])
            {
                // The secret input window for the first secret request of bot-one, read from the mock server (GET only). Nothing is typed or sent.
                var model = new Workspace(); await model.ConnectAsync(secretAddress, listen: false);
                if (model.ConnectionError is { } secretFailure) throw new BellApiException(secretFailure);
                await model.SelectAsync(model.Entries.FirstOrDefault(entry => entry.Target.Id == "bot-one") ?? throw new BellApiException("指定した会話がありません。"));
                var request = model.Messages.Select(item => item.Message.SecretRequest).FirstOrDefault(item => item is not null) ?? throw new BellApiException("秘密の依頼がありません。");
                var secretWindow = new SecretInputWindow(request, submission => model.FinishSecretAsync(request.Id, submission), () => model.SecretKeysAsync(request.Id), _ => { });
                await secretWindow.KeysReady;
                if (secretScene.EndsWith("-search", StringComparison.Ordinal)) secretWindow.SearchForRender("infra"); else if (secretScene.EndsWith("-vault", StringComparison.Ordinal)) secretWindow.SearchForRender("team");
                var secretRoot = (FrameworkElement)secretWindow.Content;
                secretRoot.Measure(new Size(secretWindow.Width, double.PositiveInfinity)); var secretHeight = (int)Math.Ceiling(Math.Min(secretRoot.DesiredSize.Height, 1500));
                WritePng(secretWindow, (int)secretWindow.Width, secretHeight, secretOutput);
                model.Dispose(); Shutdown(0); return;
            }
            if (e.Args is ["--render-workgraph", var graphAddress, var graphOutput])
            {
                // The work graph read from the mock server (GET only): the real stream and model, with a virtual clock so 12 s of simulation is stepped at 60 Hz without waiting.
                var model = new Workspace(); await model.ConnectAsync(graphAddress, listen: false);
                if (model.ConnectionError is { } graphFailure) throw new BellApiException(graphFailure);
                var graphNow = 0.0;
                var graphWindow = new WorkGraphWindow(model, _ => Task.CompletedTask, () => graphNow);
                var graphRoot = (FrameworkElement)graphWindow.Content;
                const int graphWidth = 960, graphHeight = 640;
                graphRoot.Measure(new Size(graphWidth, graphHeight)); graphRoot.Arrange(new Rect(0, 0, graphWidth, graphHeight)); graphRoot.UpdateLayout();
                graphWindow.Graph.Run((onActivity, token) => model.Management.Api.WorkGraphEventsAsync(onActivity, token), model.ConnectionToken);
                var until = DateTime.UtcNow.AddSeconds(10);
                while (graphWindow.Graph.Model.Connection != WorkGraphConnection.Live) { if (DateTime.UtcNow > until) throw new BellApiException("相関図のsnapshotを受け取れませんでした。"); await Task.Delay(20); }
                for (var frame = 0; frame < 12 * 60; frame++) { graphNow += 1.0 / 60; graphWindow.Graph.Frame(graphNow); }
                graphWindow.Graph.Stop();
                graphRoot.UpdateLayout();
                WritePng(graphWindow, graphWidth, graphHeight, graphOutput);
                model.Dispose(); Shutdown(0); return;
            }
            if (e.Args is ["--render-preview", _] || e.Args is ["--render-url", _, _] || e.Args is ["--render-url", _, _, _])
            {
                // HWNDを作らず、WPFの部品を画像へ描く。Show・Activateは呼ばない。
                var model = new Workspace();
                var window = new MainWindow(model, persistPlacement: false);
                if (e.Args[0] == "--render-url") await model.ConnectAsync(e.Args[1], listen: false);
                else model.LoadPreview();
                var first = e.Args is ["--render-url", _, var conversationId, _] ? model.Entries.FirstOrDefault(entry => entry.Target.Id == conversationId) ?? throw new BellApiException("指定した会話がありません。") : model.Entries.FirstOrDefault();
                if (first is not null) await model.SelectAsync(first);
                if (model.ConnectionError is { } renderError) throw new BellApiException(renderError);
                var root = (FrameworkElement)window.Content;
                var height = e.Args[0] == "--render-preview" ? 1200 : 820;
                root.Measure(new Size(1280, height));
                root.Arrange(new Rect(0, 0, 1280, height));
                root.UpdateLayout();
                await window.PrepareRenderAsync();
                WritePng(window, 1280, height, e.Args[^1]);
                model.Dispose();
                Shutdown(0);
                return;
            }
            if (e.Args.Length != 0) throw new ArgumentException("引数は --install-shortcut、--smoke-test <URL> <結果ファイル>、--configure <URL>、--render-preview <PNG>、--render-gallery <URL> <会話ID> <PNG>、--render-url <URL> [会話ID] <PNG>、--render-inspector <member|member-small|restart-busy|restart-success|room|sheet-small|sheet-large|sheet-unsupported|pending|pending-sheet> <URL> <会話ID> <PNG>、--render-screen <keys|approval|digits|sent|empty|offline|failed> <URL> <会話ID> <PNG>、--render-conversation <member|room|fork|secret|echo|states|stop|stop-notice|stop-member|draft|peer-sheet|stack|empty|failed> <URL> <会話ID> <PNG>、--render-secret <ssh-search|sudo-list|sudo-vault|reference|onetime|login|old> <URL> <PNG>、--render-page <settings|settings-lower|settings-<profile|ai|features|notifications|connection|display|billing|update|about|stop>|schedules|updates|updates-current|updates-narrow|updates-detail-narrow|update-sheet> <URL> <PNG>、--render-terminals <list|detail-auth-failed|detail-hostkey|detail-windows|detail-authorizing|keys|keys-pending|hostkey-sheet|editor-macos|editor-windows|editor-linux> <URL> <PNG>、--render-startup <opening|setup|guide|failure|login|onboarding-choose|onboarding-waiting|banner> <URL> <PNG>、--render-editor <member|settings|profile|feature|schedules|new-schedule|authentication> <URL> <ID> <PNG>、--render-editors <new-member|new-room|room|room-delete-alert|crop|member|member-delete-alert|member-delete-pending|member-delete-unconfirmed|folder-new|folder-new-windows|folder-new-missing|folder-new-typed|folder-picker|folder-picker-sub|folder-picker-created> <URL> <ID> <PNG> のいずれかです。");

            MainWindow? main = null;
            instance = new SingleInstance(() => Dispatcher.Invoke(() => { main!.WindowState = main.WindowState == WindowState.Minimized ? WindowState.Normal : main.WindowState; main.Show(); main.Activate(); }));
            if (!instance.IsPrimary) { Shutdown(0); return; }
            var access = new DesktopAccess();
            var workspace = new Workspace(origin => new BellApi(origin, cookies: access.Cookies), access.RestoreAsync);
            var notifications = new DesktopNotifications(new WindowsNotificationSink(), new SettingsStore(SettingsStore.UserDirectory), (server, target) => Dispatcher.BeginInvoke(() => _ = main!.OpenNotificationAsync(server, target)));
            main = new MainWindow(workspace, access: access, notifications: notifications);
            MainWindow = main;
            main.Closed += async (_, _) => { workspace.Dispose(); try { await notifications.DisposeAsync(); } catch (Exception error) { MessageBox.Show("通知の終了処理を完了できませんでした。" + error.Message, "BellTeam", MessageBoxButton.OK, MessageBoxImage.Error); } finally { Shutdown(); } };
            main.Show();
            var settings = new SettingsStore(SettingsStore.UserDirectory).Load();
            if (StartupRoute.Initial(settings.ServerUrl) == StartupPhase.Setup) main.ShowServerSetup(); else await main.ConnectAsync(settings.ServerUrl!);
        }
        catch (Exception error)
        {
            var unattended = e.Args.Length != 0;
            if (unattended)
            {
                // 自動検証で対話ダイアログを出さない。終了コードと標準エラーで失敗を返す。
                Console.Error.WriteLine(error.ToString());
            }
            else MessageBox.Show(error.Message, "BellTeam", MessageBoxButton.OK, MessageBoxImage.Error);
            Shutdown(1);
        }
    }
    // Mac preview image of the crop sheet: the left half blue, the right half green.
    private static BitmapSource SplitSwatch()
    {
        const int width = 400, height = 300; var pixels = new byte[width * height * 4];
        for (var y = 0; y < height; y++) for (var x = 0; x < width; x++) { var at = (y * width + x) * 4; var left = x < width / 2; pixels[at] = (byte)(left ? 0xFF : 0x59); pixels[at + 1] = (byte)(left ? 0x84 : 0xC2); pixels[at + 2] = (byte)(left ? 0x0A : 0x34); pixels[at + 3] = 255; }
        var bitmap = BitmapSource.Create(width, height, 96, 96, PixelFormats.Bgra32, null, pixels, width * 4); bitmap.Freeze(); return bitmap;
    }
    private static BitmapSource Swatch(byte red, byte green, byte blue)
    {
        var pixels = new byte[60 * 60 * 4]; for (var index = 0; index < pixels.Length; index += 4) { pixels[index] = blue; pixels[index + 1] = green; pixels[index + 2] = red; pixels[index + 3] = 255; }
        var bitmap = BitmapSource.Create(60, 60, 96, 96, PixelFormats.Bgra32, null, pixels, 60 * 4); bitmap.Freeze(); return bitmap;
    }
    private static System.Windows.Controls.Expander FindExpander(DependencyObject root)
    {
        var pending = new Stack<DependencyObject>(); pending.Push(root);
        while (pending.TryPop(out var current))
        {
            if (current is System.Windows.Controls.Expander expander) return expander;
            for (var index = 0; index < VisualTreeHelper.GetChildrenCount(current); index++) pending.Push(VisualTreeHelper.GetChild(current, index));
        }
        throw new InvalidOperationException("更新の詳細を描画できません。");
    }
    private static void WritePng(Window window, int width, int height, string path)
    {
        var root = (FrameworkElement)window.Content;
        // Contentだけを描く画像にも、実際の窓の背景を含める。
        if (root is System.Windows.Controls.Panel { Background: null } panel) panel.Background = window.Background ?? SystemColors.WindowBrush;
        root.Measure(new Size(width, height)); root.Arrange(new Rect(0, 0, width, height)); root.UpdateLayout();
        var bitmap = new RenderTargetBitmap(width, height, 96, 96, PixelFormats.Pbgra32); bitmap.Render(root);
        var encoder = new PngBitmapEncoder(); encoder.Frames.Add(BitmapFrame.Create(bitmap));
        var output = Path.GetFullPath(path); Directory.CreateDirectory(Path.GetDirectoryName(output)!);
        using var stream = File.Create(output); encoder.Save(stream);
    }
    protected override void OnExit(ExitEventArgs e) { instance?.Dispose(); base.OnExit(e); }
}
