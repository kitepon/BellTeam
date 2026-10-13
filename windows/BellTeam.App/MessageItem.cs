using System.ComponentModel;
using BellTeam.Core;

namespace BellTeam.App;

// 同じ会話行の部品を維持し、SSE更新中の入力と読込済み画像を残す。
public sealed class MessageItem(TimelineMessage message) : INotifyPropertyChanged
{
    public TimelineMessage Message { get; private set; } = message;
    public event PropertyChangedEventHandler? PropertyChanged;
    public void Update(TimelineMessage value)
    {
        if (Message == value) return;
        Message = value;
        PropertyChanged?.Invoke(this, new(nameof(Message)));
    }
}
