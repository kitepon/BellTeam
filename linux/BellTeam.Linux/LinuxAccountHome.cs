using Kitepon.LoginBilling.Desktop;

namespace BellTeam.Linux;

// a492: the home record (base, token, session id) in a file only the user can read, written atomically like the session token file. shortcut: no libsecret yet (same as FileSessionTokenStore).
internal sealed class FileHomeStore(string path) : IHomeStore
{
    public string? Read() => File.Exists(path) ? File.ReadAllText(path) : null;
    public void Write(string record)
    {
        Directory.CreateDirectory(Path.GetDirectoryName(path)!);
        var temporary = path + ".tmp";
        var options = new FileStreamOptions { Mode = FileMode.Create, Access = FileAccess.Write };
        if (!OperatingSystem.IsWindows()) options.UnixCreateMode = UnixFileMode.UserRead | UnixFileMode.UserWrite;
        using (var stream = new FileStream(temporary, options)) stream.Write(System.Text.Encoding.UTF8.GetBytes(record));
        File.Move(temporary, path, true);
    }
    public void Delete() { if (File.Exists(path)) File.Delete(path); }
}

// The desktop part's HomeConnection behind IHomeLink (the library's types differ from the Android part's only by namespace).
internal sealed class LinuxHomeLink(DesktopLoginBilling lb, IHomeStore store) : IHomeLink
{
    private readonly HomeConnection home = lb.HomeConnection(store);

    private static async Task<T> Map<T>(Func<Task<T>> call)
    {
        try { return await call(); }
        catch (LoginBillingException error) { throw new HomeLinkException(error.Code, error.Status); }
    }

    public Task ConnectAsync(string baseUrl, string kind, string? setupCode, CancellationToken token) => Map(async () => await home.ConnectHomeAsync(baseUrl, kind, setupCode, null, token));
    public string? Token(string url) => home.HomeHeader(url) is { } header && header.StartsWith("Bearer ", StringComparison.Ordinal) ? header["Bearer ".Length..] : null;
    public Task EndAsync(CancellationToken token) => Map(async () => { await home.EndHomeSessionAsync(token); return 0; });
    public Task ReproveIfDueAsync(string? ticketFor, CancellationToken token) => Map(async () => await home.ReproveIfDueAsync(ticketFor, token));
    public void Forget(string url) { if (home.HomeHeader(url) is not null) store.Delete(); }
}
