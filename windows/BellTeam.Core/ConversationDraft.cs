namespace BellTeam.Core;

public sealed class ConversationDraft
{
    public string Text { get; set; } = "";
    public string? Error { get; private set; }
    public bool Sending { get; private set; }
    public string[] Targets { get; set; } = [];
    public string BeginSend()
    {
        if (Sending || string.IsNullOrWhiteSpace(Text)) throw new InvalidOperationException("送信する本文がありません。あるいは送信中です。");
        var text = Text.Trim();
        Text = "";
        Error = null;
        Sending = true;
        return text;
    }
    public void CompleteSend() => Sending = false;
    public void FailSend(string sent, string error)
    {
        Text = string.Join('\n', new[] { sent, Text }.Where(part => part.Length != 0));
        Error = error;
        Sending = false;
    }
}
