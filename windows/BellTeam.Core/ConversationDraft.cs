namespace BellTeam.Core;

public sealed class ConversationDraft
{
    public string Text { get; set; } = "";
    public string? Error { get; private set; }
    public bool Sending { get; private set; }
    public bool Attaching { get; set; }
    public string[] Targets { get; set; } = [];
    // The message picked for the next send (reply.md); sent as reply_to, cleared when the send starts.
    public ReplyReference? Quote { get; set; }
    // The selected text of a part reply (full, for the request; Quote.Text is cut for display).
    public QuoteSelection? Selection { get; set; }
    public List<ImageAttachment> Attachments { get; } = [];
    public bool HasContent => !string.IsNullOrWhiteSpace(Text) || Attachments.Count != 0;
    public string BeginSend() => BeginSendContent().Text;
    public DraftContent BeginSendContent()
    {
        if (Sending || Attaching || !HasContent) throw new InvalidOperationException(CoreStrings.ConversationDraft_BeginSendContent_1);
        var sent = new DraftContent(Text.Trim(), Attachments.ToArray(), Targets.ToArray(), Quote, Selection);
        Text = "";
        Quote = null; Selection = null;
        Attachments.Clear();
        Error = null;
        Sending = true;
        return sent;
    }
    // A refusal to send (or a failed paste) shown above the input; the next send clears it.
    public void Reject(string error) => Error = error;
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
        if (Quote is null) { Quote = sent.Quote; Selection = sent.Selection; }
        FailSend(sent.Text, error);
    }
}

// The composer's reply-target capsule in a room, worded like the Mac targetLabel.
public static class ReplyTarget
{
    public static string Label(bool routingEnabled, IReadOnlyList<string> selectedNames)
        => selectedNames.Count == 0 ? routingEnabled ? CoreStrings.ConversationDraft_Label_1 : CoreStrings.ConversationDraft_Label_2
        : selectedNames.Count == 1 ? CoreStrings.ConversationDraft_Label_3(selectedNames[0]) : CoreStrings.ConversationDraft_Label_4(selectedNames.Count);
    public static string RoutingUnsetError  => CoreStrings.ConversationDraft_RoutingUnsetError_1;
}
