using System.Text;
using System.Text.Json;

namespace BellTeam.PeerChannel;

// Holder-side registry rules (contract 4.1-4.4): one rule set for every holder and every source. A port of ts/src/registry.ts and the body parsing of ts/src/snapshot.ts.
public sealed record Entry(string KeyId, string SigPub, string SealPub, string AddedBy, string? Platform, string? Protection, string? ConnectionId = null)
{
    public bool IsDevice => Platform is not null;
}

public sealed record SnapshotBody(string Account, long Version, IReadOnlyList<Entry> Devices, IReadOnlyList<Entry> Connectors, IReadOnlyList<string> Removed)
{
    // Active keys of a body: (devices + connectors) minus removed (0.4.4: a self-removal lists the signer in both).
    public IEnumerable<Entry> Active() => Devices.Concat(Connectors).Where(e => !Removed.Contains(e.KeyId));

    // Parses body bytes only after a signature check; null when the shape is not a pc1 registry body.
    public static SnapshotBody? Parse(byte[] bytes)
    {
        try
        {
            using var document = JsonDocument.Parse(new UTF8Encoding(false, true).GetString(bytes));
            var b = document.RootElement;
            if (b.ValueKind != JsonValueKind.Object || Text(b, "v") != "pc1-registry" || Text(b, "account") is not { } account
                || !b.TryGetProperty("version", out var version) || !version.TryGetInt64(out var number) || number < 1
                || !Array(b, "prev", out _) || !Array(b, "devices", out var devices) || !Array(b, "connectors", out var connectors) || !Array(b, "removed", out var removed)) return null;
            return new SnapshotBody(account, number, devices.Select(Read).ToList(), connectors.Select(Read).ToList(), removed.Select(r => Text(r, "key_id") ?? "").ToList());
        }
        catch (Exception error) when (error is JsonException or ArgumentException or InvalidOperationException) { return null; }
    }

    private static string? Text(JsonElement e, string name) => e.ValueKind == JsonValueKind.Object && e.TryGetProperty(name, out var v) && v.ValueKind == JsonValueKind.String ? v.GetString() : null;
    private static bool Array(JsonElement e, string name, out List<JsonElement> items)
    {
        items = [];
        if (!e.TryGetProperty(name, out var v) || v.ValueKind != JsonValueKind.Array) return false;
        items = v.EnumerateArray().ToList();
        return true;
    }
    private static Entry Read(JsonElement e) => new(Text(e, "key_id") ?? "", Text(e, "sig_pub") ?? "", Text(e, "seal_pub") ?? "", Text(e, "added_by") ?? "", Text(e, "platform"), Text(e, "protection"), Text(e, "connection_id"));
}

public sealed record Head(string Hash, SnapshotBody Body, string Signer); // Hash = hex SHA-256 of the body bytes

public sealed record Holder(string Account, long Version, IReadOnlyList<Head> Heads, IReadOnlyDictionary<string, Entry> Active, IReadOnlySet<string> Tombstoned);

public enum Source { Mirror, Session, Admission }

// No cooling period since 0.5.0: a newly admitted device signs like any other.
public enum Outcome { Head, Removals, RegistryRefused, Ignored }

public static class Registry
{
    // Rule 1 against a known signer key: signature over the bytes first, then parse, then account and listing.
    private static SnapshotBody? Valid(SignedSnapshot s, string account, Entry signer)
    {
        if (!s.Verify(Bytes.FromB64Url(signer.SigPub))) return null;
        var body = SnapshotBody.Parse(s.Body);
        if (body is null || body.Account != account) return null;
        var listed = body.Devices.FirstOrDefault(d => d.KeyId == signer.KeyId); // never a key found only in connectors[]
        return listed is not null && listed.SigPub == signer.SigPub ? body : null;
    }

    private static string Hex(byte[] bytes) => Convert.ToHexStringLower(bytes);

    // Trusts a snapshot whose hash the holder already has from a binding-checked admission payload (5.2-5.4), or the holder's own genesis.
    public static Holder? Adopt(SignedSnapshot s, byte[] expectedHash, string account)
    {
        if (!s.Hash().AsSpan().SequenceEqual(expectedHash)) return null;
        var body = SnapshotBody.Parse(s.Body); // the hash, not the signature, is the trust anchor here
        var signer = body?.Devices.FirstOrDefault(d => d.KeyId == Bytes.B64Url(s.Signer));
        if (body is null || signer is null || signer.Protection == "browser" || Valid(s, account, signer) is null) return null;
        var tombstoned = body.Removed.ToHashSet();
        if (tombstoned.Contains(signer.KeyId)) return null;
        return new Holder(account, body.Version, [new Head(Hex(expectedHash), body, signer.KeyId)], body.Active().ToDictionary(e => e.KeyId), tombstoned);
    }

    // Applies one batch (4.3 steps 1-6). Returns the new holder state and one outcome per input snapshot.
    public static (Holder Holder, Outcome[] Outcomes) ApplyBatch(Holder h, Source source, IReadOnlyList<SignedSnapshot> batch, byte[]? admitHash = null)
    {
        var active = h.Active;
        var tombstoned = new HashSet<string>(h.Tombstoned);
        var outcomes = new List<Outcome>();
        var considered = new List<Head>();

        foreach (var s in batch)
        {
            var signerId = Bytes.B64Url(s.Signer);
            active.TryGetValue(signerId, out var signer);
            // Admission: only the snapshot named by the binding-checked payload counts.
            if (source == Source.Admission && (admitHash is null || !s.Hash().AsSpan().SequenceEqual(admitHash))) { outcomes.Add(Outcome.Ignored); continue; }
            // Step 2 before parsing: an unknown signer costs no parse.
            if (signer is null || !signer.IsDevice || tombstoned.Contains(signerId) || signer.Protection == "browser") { outcomes.Add(Outcome.Ignored); continue; }
            var body = Valid(s, h.Account, signer);
            if (body is null) { outcomes.Add(Outcome.RegistryRefused); continue; }
            considered.Add(new Head(Hex(s.Hash()), body, signerId));
            outcomes.Add(Outcome.Removals);
        }

        // Step 3: removals from every considered snapshot, then the added-by cascade over the active set.
        var removers = new Dictionary<string, List<Head>>();
        var queue = new Queue<string>();
        foreach (var c in considered)
            foreach (var removed in c.Body.Removed)
            {
                if (!removers.TryGetValue(removed, out var list)) removers[removed] = list = [];
                list.Add(c);
                if (tombstoned.Add(removed)) queue.Enqueue(removed);
            }
        while (queue.Count > 0)
        {
            var x = queue.Dequeue();
            var keptBy = removers.TryGetValue(x, out var list) ? list : []; // keys the remover saw and kept are spared
            foreach (var k in active.Keys)
            {
                if (tombstoned.Contains(k) || keptBy.Any(c => c.Body.Active().Any(e => e.KeyId == k)) || !ChainReaches(active, k, x)) continue;
                tombstoned.Add(k);
                removers[k] = keptBy;
                queue.Enqueue(k);
            }
        }

        // Steps 4-6: adds only through a new head, never from a session.
        var candidates = source == Source.Session ? [] : considered.Where(c =>
            !tombstoned.Contains(c.Signer) && (c.Body.Version > h.Version || (c.Body.Version == h.Version && !h.Heads.Any(hd => hd.Hash == c.Hash)))).ToList();
        Holder next;
        if (candidates.Count == 0)
            next = h with { Tombstoned = tombstoned, Active = active.Where(p => !tombstoned.Contains(p.Key)).ToDictionary(p => p.Key, p => p.Value) };
        else
        {
            var version = candidates.Max(c => c.Body.Version);
            var fork = new Dictionary<string, Head>();
            if (version == h.Version) foreach (var hd in h.Heads) if (!tombstoned.Contains(hd.Signer)) fork[hd.Hash] = hd; // fork with the head (4.4)
            foreach (var c in candidates) if (c.Body.Version == version) fork[c.Hash] = c;
            var merged = new Dictionary<string, Entry>();
            foreach (var hd in fork.Values) foreach (var e in hd.Body.Active()) if (!tombstoned.Contains(e.KeyId)) merged[e.KeyId] = e;
            next = new Holder(h.Account, version, fork.Values.ToList(), merged, tombstoned);
        }
        var headHashes = next.Heads.Select(hd => hd.Hash).ToHashSet();
        return (next, outcomes.Select((o, i) => o == Outcome.Removals && headHashes.Contains(Hex(batch[i].Hash())) ? Outcome.Head : o).ToArray());
    }

    private static bool ChainReaches(IReadOnlyDictionary<string, Entry> active, string from, string target)
    {
        var seen = new HashSet<string>();
        for (string? k = from; k is not null && seen.Add(k);)
        {
            var by = active.TryGetValue(k, out var entry) ? entry.AddedBy : null;
            if (by == target) return true;
            k = by == k ? null : by;
        }
        return false;
    }
}
