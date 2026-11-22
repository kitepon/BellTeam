using System.Net.Http;
using System.Text;
using System.Text.Json;
using BellTeam.PeerChannel;

namespace BellTeam.Linux;

/// <summary>
/// The decisions of this Linux device (port of the Windows DeviceApprovals, design peer-channel-v0.2 section 7): its keys (0600 file), the trusted registry head, the history of decisions (0600 file) and the <see cref="DeviceRuntime"/> that keeps it connected.
/// How the pass reaches approval-box is the caller's: <paramref name="access"/> gives the server and its header, <paramref name="account"/> gives K for a first registry.
/// </summary>
internal sealed class LinuxDeviceApprovals : IDeviceDecisions, IAsyncDisposable
{
        private readonly string directory; private readonly DeviceIdentity me; private readonly Func<CancellationToken, Task<string>> account; private readonly Func<CancellationToken, Task<ServerAccess>> access;
    private readonly object saving = new();
    internal DeviceRuntime Runtime { get; }
    public DecisionBook Book => Runtime.Book;
    public RuntimeState State => Runtime.State;
    public event Action? Changed;
    public Task<SendOutcome> AnswerAsync(string decisionId, string? optionId, string? text) => Runtime.AnswerAsync(decisionId, optionId, text);
    public Task<SendOutcome> HoldAsync(string decisionId, bool held) => Runtime.HoldAsync(decisionId, held);
    public void Refresh() => Runtime.Refresh();
    public Task<byte[]?> AttachmentAsync(string decisionId, string attachmentId) => Task.FromResult(Book.FindByDecision(decisionId)?.Blobs?.Any(b => b.BlobId == attachmentId) == true ? Runtime.Attachment(attachmentId) : null);
    internal void Start() => Runtime.Start();
    private string AnchorPath => Path.Combine(directory, "peer-channel-registry.json");
    private string HistoryPath => Path.Combine(directory, "approvals-history.json");

    internal LinuxDeviceApprovals(string directory, Func<CancellationToken, Task<ServerAccess>> access, Func<CancellationToken, Task<string>> account, string label)
    {
        this.directory = directory; this.account = account; this.access = access;
        me = LinuxDeviceKeyStore.LoadOrCreate(Path.Combine(directory, "peer-channel-device.key"));
        var book = LoadHistory(HistoryPath);
        book.Changed += () => { SaveHistory(HistoryPath, book); Changed?.Invoke(); };
        Runtime = new DeviceRuntime(new(me, label, access, RegistryAsync, book, Files: new LinuxBlobFiles(Path.Combine(directory, "approvals-files"))));
        Runtime.StateChanged += () => { if (Runtime.State is { Status: RuntimeStatus.SignedOut, Reason: "account_deleted" }) ClearLocal(); Changed?.Invoke(); };
    }

    internal DeviceAdmission NewAdmission() => new(me, "linux", "software", DateTimeOffset.UtcNow.ToUnixTimeMilliseconds());

    // Runs the 5.3 starter to its end: the admitted snapshot becomes the kept registry head and the waiting connection tries again at once. Throws AdmissionException (binding_failed / binding_expired).
    internal async Task AdmitAsync(DeviceAdmission admission, CancellationToken ct)
    {
        var id = await account(ct);
        var (snapshot, _) = await admission.CompleteAsync(await access(ct), id, ct: ct);
        SaveAnchor(id, snapshot);
        Runtime.Refresh();
    }

    // The registry this device trusts: the head it kept (its own genesis or an admission) brought up to date from the mirror. No head and an empty mirror: this is the first device and makes the genesis (5.1).
    // No head and slots it cannot verify: not verified (null), the runtime says NeedsAdmission and waits for an admission (5.3, a separate step).
    private async Task<Holder?> RegistryAsync(ServerAccess access, CancellationToken ct)
    {
        using var http = new HttpClient();
        var slots = await SignalHttp.FetchMirrorAsync(http, access, ct);
        var kept = LoadAnchor();
        var holder = kept is { } k ? Registry.Adopt(k.Snapshot, k.Snapshot.Hash(), k.Account) : null;
        string accountId;
        if (holder is null)
        {
            if (slots.Count > 0) return null;
            accountId = await account(ct);
            var genesis = Genesis.Create(me, accountId, "linux", "software", DateTimeOffset.UtcNow.ToUnixTimeMilliseconds());
            if (await SignalHttp.PutMirrorAsync(http, access, genesis, ct) is { } refused) throw new InvalidOperationException("the first registry was refused: " + refused);
            holder = Registry.Adopt(genesis, genesis.Hash(), accountId) ?? throw new InvalidOperationException("own genesis not adopted");
            slots = [genesis];
        }
        else accountId = holder.Account;
        var (next, _) = Registry.ApplyBatch(holder, Source.Mirror, slots);
        if (slots.FirstOrDefault(s => Convert.ToHexStringLower(s.Hash()) == next.Heads[0].Hash) is { } head) SaveAnchor(accountId, head);
        if (!next.Active.ContainsKey(Bytes.B64Url(me.KeyId))) throw new NeedsApprovalException("removed"); // listed once and now gone: removed by another device (5.5)
        return next;
    }

    // The Approval Box account was deleted (4410): this device's keys, trusted head and history go with it (the pass is the second instance's own to clear).
    private void ClearLocal()
    {
        foreach (var file in new[] { Path.Combine(directory, "peer-channel-device.key"), AnchorPath, HistoryPath }) try { File.Delete(file); } catch (IOException) { }
    }

    private (string Account, SignedSnapshot Snapshot)? LoadAnchor()
    {
        try
        {
            if (!File.Exists(AnchorPath)) return null;
            using var doc = JsonDocument.Parse(File.ReadAllText(AnchorPath)); var r = doc.RootElement;
            return (r.GetProperty("account").GetString()!, new SignedSnapshot(Bytes.FromB64Url(r.GetProperty("body").GetString()!), Bytes.FromB64Url(r.GetProperty("signer").GetString()!), Bytes.FromB64Url(r.GetProperty("sig").GetString()!)));
        }
        catch (Exception error) when (error is JsonException or KeyNotFoundException or FormatException or IOException) { return null; } // no kept head: the mirror decides again
    }

    private void SaveAnchor(string accountId, SignedSnapshot head)
    {
        Directory.CreateDirectory(directory);
        var temp = AnchorPath + ".tmp";
        File.WriteAllText(temp, JsonSerializer.Serialize(new { account = accountId, body = Bytes.B64Url(head.Body), signer = Bytes.B64Url(head.Signer), sig = Bytes.B64Url(head.Sig) }));
        File.Move(temp, AnchorPath, overwrite: true);
    }

    // The history holds titles, bodies and answers: a file only the user can read (0600). A file that does not parse is no history.
    internal static DecisionBook LoadHistory(string path)
    {
        try { if (File.Exists(path)) return DecisionBook.Import(Encoding.UTF8.GetString(File.ReadAllBytes(path))); }
        catch (Exception error) when (error is IOException or JsonException or FormatException or ArgumentException) { }
        return new DecisionBook();
    }

    private void SaveHistory(string path, DecisionBook book) { lock (saving) SaveHistoryFile(path, book); }
    internal static void SaveHistoryFile(string path, DecisionBook book) => SecretFile.Write(path, Encoding.UTF8.GetBytes(book.Export()));

    public ValueTask DisposeAsync() => Runtime.DisposeAsync();
}



/// <summary>What the 決裁箱 page needs from this device's peer-channel session (DeviceApprovals in the app, a fake in tests).</summary>
internal interface IDeviceDecisions
{
    DecisionBook Book { get; }
    RuntimeState State { get; }
    /// <summary>The book or the connection state changed (any thread).</summary>
    event Action? Changed;
    Task<SendOutcome> AnswerAsync(string decisionId, string? optionId, string? text);
    Task<SendOutcome> HoldAsync(string decisionId, bool held);
    /// <summary>Manual retry of the waiting connection attempt.</summary>
    void Refresh();
    /// <summary>The bytes of a request image (the blob id of the decision's attachment), or null when this device does not hold them.</summary>
    Task<byte[]?> AttachmentAsync(string decisionId, string attachmentId);
}
