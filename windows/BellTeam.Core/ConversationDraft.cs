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
        FailSend(sent.Text, error);
    }
}

// The composer's reply-target capsule in a room, worded like the Mac targetLabel.
public static class ReplyTarget
{
    public static string Label(bool routingEnabled, IReadOnlyList<string> selectedNames)
        => selectedNames.Count == 0 ? routingEnabled ? "返信者を自動選択" : "返信するメンバーを選択"
        : selectedNames.Count == 1 ? "返信: " + selectedNames[0] : $"返信: {selectedNames.Count}人";
    public const string RoutingUnsetError = "返信者の自動選択は未設定です。入力欄の上で返信するメンバーを選んでください。";
}
