namespace BellTeam.Core;

public sealed class ConversationDraft
{
    public string Text { get; set; } = "";
    public string? Error { get; private set; }
    public bool Sending { get; private set; }
    public bool Attaching { get; set; }
    public string[] Targets { get; set; } = [];
    public List<ImageAttachment> Attachments { get; } = [];
    public bool HasContent => !string.IsNullOrWhiteSpace(Text) || Attachments.Count != 0;
    public string BeginSend() => BeginSendContent().Text;
    public DraftContent BeginSendContent()
    {
        if (Sending || Attaching || !HasContent) throw new InvalidOperationException("送信する本文・画像がありません。あるいは送信・読込中です。");
        var sent = new DraftContent(Text.Trim(), Attachments.ToArray(), Targets.ToArray());
        Text = "";
        Attachments.Clear();
        Error = null;
        Sending = true;
        return sent;
    }
    public void CompleteSend() => Sending = false;
    public void FailSend(string sent, string error)
    {
        Text = string.Join('\n', new[] { sent, Text }.Where(part => part.Length != 0));
        Error = error;
        Sending = false;
    }
    public void FailSend(DraftContent sent, string error)
    {
        Attachments.InsertRange(0, sent.Images);
        FailSend(sent.Text, error);
    }
}
