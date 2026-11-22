using System.IO;
using System.Text;
using System.Text.Json;
using BellTeam.App;
using BellTeam.PeerChannel;

namespace BellTeam.Tests;

public class DeviceAttachmentsTests
{
    private static readonly byte[] Png = [0x89, 0x50, 0x4E, 0x47, 1, 2, 3];
    private static readonly BlobMeta Meta = BlobMeta.Of(Png, "image/png", "画面.png");
    private const string Req = "{\"id\":\"f1\",\"at\":1,\"rid\":\"r1\",\"rv\":1,\"schema\":\"approval-box/decision@1\",\"content\":{\"decision_id\":\"K-1\",\"title\":\"t\",\"options\":[]}}";
    private static Received Frame(string t, string json, params (BlobMeta, byte[])[] blobs) { var b = Encoding.UTF8.GetBytes(json); return new(t, JsonDocument.Parse(json), b, new BellTeam.PeerChannel.Frame(t, b, []), blobs.Length == 0 ? null : blobs); }

    [Fact]
    public void ARequestKeepsItsImagesBeforeTheBookNamesThemAndTheViewDescribesThem()
    {
        var book = new DecisionBook(); var kept = new List<string>();
        Assert.Equal("ok", DeviceFrames.Handle(Frame("request", Req, (Meta, Png)), book, _ => throw new InvalidOperationException(), 1, (m, bytes) => { Assert.Null(book.Find("r1")); kept.Add(m.BlobId); Assert.Equal(Png, bytes); }));
        Assert.Equal([Meta.BlobId], kept);
        var entry = book.Find("r1")!; Assert.Equal([Meta], entry.Blobs);
        var attachment = Assert.Single(DeviceDecisionView.Of(entry).RequestAttachments!);
        Assert.Equal((Meta.BlobId, "画面.png", "image/png", (long)Png.Length, Convert.ToHexString(System.Security.Cryptography.SHA256.HashData(Png))), (attachment.Id, attachment.Name, attachment.ContentType, attachment.Size, attachment.Sha256));
        var back = DecisionBook.Import(book.Export()).Find("r1")!; Assert.Equal([Meta], back.Blobs);       // the names survive the history file
        Assert.Null(DeviceDecisionView.Of(DecisionBook.Import("[]").Find("x") ?? entry with { Blobs = null }).RequestAttachments);
    }

    [Fact]
    public void AnAmendReplacesTheNamedImagesAndACancelLeavesThem()
    {
        var book = new DecisionBook(); DeviceFrames.Handle(Frame("request", Req, (Meta, Png)), book, _ => throw new InvalidOperationException(), 1);
        var amend = Req.Replace("\"id\":\"f1\"", "\"id\":\"f2\"").Replace("\"rv\":1", "\"rv\":2");
        DeviceFrames.Handle(Frame("amend", amend), book, _ => throw new InvalidOperationException(), 2);
        Assert.Null(book.Find("r1")!.Blobs);
        var other = BlobMeta.Of([9, 9], "image/png", "b.png");
        DeviceFrames.Handle(Frame("amend", amend.Replace("\"rv\":2", "\"rv\":3"), (other, [9, 9])), book, _ => throw new InvalidOperationException(), 3);
        DeviceFrames.Handle(Frame("cancel", "{\"id\":\"f4\",\"rid\":\"r1\",\"rv\":3}"), book, _ => throw new InvalidOperationException(), 4);
        Assert.Equal([other], book.Find("r1")!.Blobs!); Assert.Equal(DecisionStatus.Cancelled, book.Find("r1")!.Status);
    }

    [Fact]
    public void TheSealedFilesReturnTheBytesRefuseAnythingThatIsNotABlobIdAndGiveNothingForAFileThatDoesNotUnseal()
    {
        var dir = Path.Combine(Path.GetTempPath(), "bt-blob-" + Guid.NewGuid().ToString("N"));
        try
        {
            var files = new SealedBlobFiles(dir); files.Write(Meta.BlobId, Png);
            Assert.Equal(Png, files.Read(Meta.BlobId));
            Assert.DoesNotContain((byte)0x89, File.ReadAllBytes(Path.Combine(dir, Meta.BlobId)).Take(1));       // sealed, not the image itself
            Assert.Null(files.Read(BlobMeta.Of([7], "image/png", "n").BlobId));
            Assert.Throws<ArgumentException>(() => files.Write("..\\evil", Png));
            Assert.Null(files.Read("..\\evil"));
            File.WriteAllBytes(Path.Combine(dir, Meta.BlobId), [1, 2, 3]); Assert.Null(files.Read(Meta.BlobId));
        }
        finally { if (Directory.Exists(dir)) Directory.Delete(dir, true); }
    }
}
