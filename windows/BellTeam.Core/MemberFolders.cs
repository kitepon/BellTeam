using System.Text;

namespace BellTeam.Core;

// Member editor 「端末とフォルダ」 (members C1/S5, terminals "Folder picker" S6; the Mac's apple/terminals.md and the folder half of Core/Terminals.swift).

// members S5: a refused member save carries only `{error: code}` and the status, so the app words each code and names the form's folder.
public sealed record MemberFolderRefusal(string Text, bool OffersCreate);

public static class MemberFolder
{
    public const string CreateTitle = "このフォルダを作って保存";

    // `<home>/BellTeam/<slug>` in the terminal's form: `/Users/<user>` (macOS), `/home/<user>` (Linux), `C:\Users\<user>` (Windows).
    // slug = trimmed name with `/`, `\`, `:`, NUL -> `-`, `member` when empty, `.` or `..`.
    public static string DefaultPath(string user, string name, string os = TerminalOS.Macos)
    {
        var slug = name.Trim();
        foreach (var character in new[] { "/", "\\", ":", "\0" }) slug = slug.Replace(character, "-");
        if (slug.Length == 0 || slug is "." or "..") slug = "member";
        return os switch
        {
            TerminalOS.Windows => $@"C:\Users\{user}\BellTeam\{slug}",
            TerminalOS.Linux => $"/home/{user}/BellTeam/{slug}",
            _ => $"/Users/{user}/BellTeam/{slug}"
        };
    }

    // The prefill follows name and terminal changes only while the field still holds the last prefill (or is empty); typed text stays.
    public static string? Prefill(string current, string? lastPrefill, string user, string name, string os = TerminalOS.Macos)
    {
        if (current.Length != 0 && current != lastPrefill) return null;
        var next = DefaultPath(user, name, os);
        return next == current ? null : next;
    }

    // The Full Disk Access step is macOS only (terminals "Windows and Linux terminals").
    public static string? Words(string code, string os = TerminalOS.Macos)
    {
        var machine = TerminalOS.Machine(os);
        return code switch
        {
            "FOLDER_MISSING" => $"このフォルダは{machine}にありません。作るか、あるフォルダを選んでください",
            "FOLDER_NOT_DIRECTORY" => "これはファイルです。フォルダを選んでください",
            "FOLDER_NOT_WRITABLE" => $"この{machine}のユーザーが書き込めるフォルダを選んでください",
            "FOLDER_NOT_PERMITTED" => os == TerminalOS.Macos
                ? "Macがこのフォルダを開かせてくれません。デスクトップ・書類・ダウンロードの外を選ぶか、リモートログインの「リモートユーザにフルディスクアクセスを許可」をオンにしてください"
                : $"{machine}がこのフォルダを開かせてくれません。この{machine}のユーザーが開けるフォルダを選んでください",
            _ => null
        };
    }

    // null = not a folder refusal. An unknown FOLDER_* code gets one plain line (a later server may add codes). Only FOLDER_MISSING offers 「このフォルダを作って保存」.
    public static MemberFolderRefusal? Refusal(string? code, string folder, string os = TerminalOS.Macos)
    {
        if (code is null) return null;
        if (code == "TERMINAL_NOT_FOUND") return new("この端末は登録されていません。", false);
        if (!code.StartsWith("FOLDER_", StringComparison.Ordinal)) return null;
        return new($"{Words(code, os) ?? "このフォルダは使えません"}（{folder}）。", code == "FOLDER_MISSING");
    }
}

// members C1: both empty (this BellTeam) or both set; projectRoot an absolute path in the terminal's native form
// (terminals "Windows and Linux terminals": POSIX `/...`, Windows drive-absolute `X:\...`).
public static class MemberBinding
{
    public static string? Problem(string terminalId, string projectRoot, string os = TerminalOS.Macos)
    {
        if (terminalId.Length != 0 && !TerminalPattern.Whole(terminalId, "[A-Za-z0-9][A-Za-z0-9._-]{0,127}")) return TerminalErrorText.Member("BOT_TERMINAL_ID_INVALID");
        if (projectRoot.Length != 0 && FolderProblem(projectRoot, os) is { } folder) return folder;
        if ((terminalId.Length == 0) != (projectRoot.Length == 0))
            return terminalId.Length == 0 ? TerminalErrorText.Member("BOT_REMOTE_BINDING_INVALID") : "フォルダを入れてください。端末で席が起動する場所です。";
        return null;
    }

    public static string? FolderProblem(string path, string os = TerminalOS.Macos)
    {
        if (os == TerminalOS.Windows)
        {
            // `X:\` is the root; `/` is refused so one form travels; at most 1024 characters.
            if (!TerminalPattern.Whole(path, @"[A-Za-z]:\\[^/\x00]*") || path.Length > 1024) return TerminalErrorText.Member("BOT_PROJECT_ROOT_INVALID", os);
            if (path.Length > 3 && path[3..].Split('\\').Any(segment => segment.Length == 0 || segment is "." or "..")) return TerminalErrorText.Member("BOT_PROJECT_ROOT_INVALID", os);
            return null;
        }
        if (!path.StartsWith('/') || path.Contains('\0') || Encoding.UTF8.GetByteCount(path) > 4096) return TerminalErrorText.Member("BOT_PROJECT_ROOT_INVALID");
        if (path != "/" && path[1..].Split('/').Any(segment => segment.Length == 0 || segment is "." or "..")) return TerminalErrorText.Member("BOT_PROJECT_ROOT_INVALID");
        return null;
    }
}

// S6 folder picker: the folders of a registered terminal are listed and chosen on screen.
public sealed record TerminalFolderEntry { public required string Name { get; init; } public required string Path { get; init; } }

// `GET /api/terminals/:id/folders[?path=]`. Every field but the entries may be missing (an unknown home, a refused read).
public sealed record TerminalFolders
{
    public string? Home { get; init; }
    public string? Path { get; init; }
    // null at `/` (no 「上へ」).
    public string? Parent { get; init; }
    public TerminalFolderEntry[]? Entries { get; init; }
    public bool? Truncated { get; init; }
    // null = listed. Otherwise the entries are empty and `action` is the server's Japanese sentence.
    public string? Reason { get; init; }
    public string? Action { get; init; }
}

// `POST /api/terminals/:id/folder` answer; the picker reads only `reason` and `action` (reason null = the folder is usable).
public sealed record TerminalFolderStatus { public string? Path { get; init; } public string? Reason { get; init; } public string? Action { get; init; } }

public static class TerminalFolderPicker
{
    public const string EmptyText = "フォルダはありません", TruncatedText = "フォルダが多いため、すべては表示していません。",
        ReadFailedText = "フォルダの一覧を読み込めませんでした。つながりを確かめて、もう一度お試しください。",
        UnsupportedText = "このBellTeamはまだ、フォルダを選ぶ画面に対応していません。「ほかの方法」でパスを入力してください。",
        CreateFailedText = "フォルダを作れたか確かめられませんでした。一覧で確かめてください。";
    public static string UnreachableText(string os = TerminalOS.Macos) => $"いまこの端末に届きません。{TerminalOS.Machine(os)}が起きていて同じネットワークにあるか確かめて、もう一度お試しください。";

    // The name is trimmed; the result is what is sent. A null problem = usable. The server only ever sees ChildPath.
    // terminals: an entry name never holds `/`, `\` (Windows also `:`) or NUL.
    public static (string Name, string? Problem) Name(string raw, string os = TerminalOS.Macos)
    {
        var name = raw.Trim();
        var problem = name.Length == 0 ? "フォルダの名前を入れてください。"
            : name.Contains('/') ? "名前に「/」は使えません。"
            : name.Contains('\\') ? "名前に「\\」は使えません。"
            : os == TerminalOS.Windows && name.Contains(':') ? "名前に「:」は使えません。"
            : name is "." or ".." ? "「.」と「..」は名前にできません。"
            : name.Contains('\0') ? "名前に使えない文字があります。"
            : Encoding.UTF8.GetByteCount(name) > 255 ? "名前が長すぎます（255バイトまで）。"
            : null;
        return (name, problem);
    }

    // Joined with the terminal's separator; a root (`/`, `X:\`) already ends with it.
    public static string ChildPath(string parent, string name, string os = TerminalOS.Macos)
    {
        var separator = os == TerminalOS.Windows ? "\\" : "/";
        return parent.EndsWith(separator, StringComparison.Ordinal) ? parent + name : parent + separator + name;
    }

    // One plain sentence for a reason. Unreachable reasons never read as an empty list; FOLDER_NOT_PERMITTED is S5's sentence.
    public static string Sentence(string reason, string? action, string os = TerminalOS.Macos)
    {
        if (reason == "TERMINAL_NOT_FOUND") return "この端末は登録されていません。";
        if (reason == "FOLDER_NOT_PERMITTED") return FolderWords(reason, os);
        var check = new TerminalCheck { TerminalId = "", Reachable = false, Reason = reason, Action = action };
        if (check.Problem == TerminalCheck.ProblemKind.Unreachable) return UnreachableText(os);
        if (action?.Trim() is { Length: > 0 } sentence) return sentence;
        return MemberFolder.Words(reason) is not null ? FolderWords(reason, os) : check.Explanation(os) ?? FolderWords(reason, os);
    }
    private static string FolderWords(string reason, string os) => (MemberFolder.Words(reason, os) ?? "このフォルダは使えません") + "。";

    // The query value: everything but unreserved characters and `/` is escaped (a folder may contain `+`, `&`, `#`).
    public static string Query(string path) => Uri.EscapeDataString(path).Replace("%2F", "/");
}

public enum FolderContent { Loading, Listed, Failed, Unsupported }

// The picker's state: what is shown, and the new-folder form. Reads write nothing; a create is sent once, never resent.
public sealed class TerminalFolderPickerModel(string os, Func<string?, CancellationToken, Task<TerminalFolders>> read, Func<string, CancellationToken, Task<TerminalFolderStatus>> make, CancellationToken token = default)
{
    private int sequence;
    public FolderContent Content { get; private set; } = FolderContent.Loading;
    public TerminalFolders? Listed { get; private set; }
    // Failed: one sentence and 「もう一度」.
    public string? FailedText { get; private set; }
    public string NewName { get; set; } = "";
    public string? CreateNote { get; private set; }
    public bool Creating { get; private set; }
    // The path last asked for (null = the terminal user's home); 「もう一度」 asks for it again.
    public string? Requested { get; private set; }
    // The terminal's `os`: the new folder's name rule, separator and sentences.
    public string Os => os;
    public event Action? Changed;
    private void Show(FolderContent content, TerminalFolders? listed = null, string? failed = null) { Content = content; Listed = listed; FailedText = failed; Changed?.Invoke(); }

    // Only the newest request writes the content.
    public async Task OpenAsync(string? path)
    {
        var mine = ++sequence;
        Requested = path;
        if (!Creating) CreateNote = null;
        Show(FolderContent.Loading);
        try
        {
            var result = await read(path, token);
            if (mine == sequence) Show(FolderContent.Listed, result);
        }
        catch (OperationCanceledException) when (token.IsCancellationRequested) { }
        catch (Exception error)
        {
            if (mine != sequence) return;
            if (TerminalErrorText.IsFoldersUnsupported(error)) Show(FolderContent.Unsupported);
            else Show(FolderContent.Failed, failed: TerminalErrorText.Code(error) == "TERMINAL_NOT_FOUND" ? "この端末は登録されていません。" : TerminalFolderPicker.ReadFailedText);
        }
    }

    public Task ReloadAsync() => OpenAsync(Requested);

    // Create `<current>/<name>`, list `<current>` again, then open the new folder (that is the selection).
    public async Task CreateFolderAsync()
    {
        if (Creating || Content != FolderContent.Listed || Listed?.Path is not { } directory) return;
        var (name, problem) = TerminalFolderPicker.Name(NewName, os);
        if (problem is not null) { CreateNote = problem; Changed?.Invoke(); return; }
        var path = TerminalFolderPicker.ChildPath(directory, name, os);
        Creating = true; CreateNote = null; Changed?.Invoke();
        try
        {
            TerminalFolderStatus status;
            try { status = await make(path, token); }
            catch (OperationCanceledException) when (token.IsCancellationRequested) { return; }
            catch (Exception)
            {
                // A lost answer: the folder may exist. Not sent again; the current place is listed so the owner can see.
                CreateNote = TerminalFolderPicker.CreateFailedText; await OpenAsync(directory); return;
            }
            if (status.Reason is { } reason) { CreateNote = TerminalFolderPicker.Sentence(reason, status.Action, os); Changed?.Invoke(); return; }
            NewName = "";
            await OpenAsync(directory);
            if (Content == FolderContent.Listed) await OpenAsync(path);
        }
        finally { Creating = false; Changed?.Invoke(); }
    }
}
