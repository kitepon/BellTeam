using System.Globalization;
using System.Text.Json;
using System.Text.Json.Serialization;

namespace BellTeam.Core;

public sealed record Schedule
{
    public required string Id { get; init; }
    public string Name { get; init; } = "";
    public required string Kind { get; init; }
    public string? Prompt { get; init; }
    public string? Command { get; init; }
    public string? At { get; init; }
    public string? Expression { get; init; }
    public string? Timezone { get; init; }
    public string? NextRunAt { get; init; }
    public bool Enabled { get; init; } = true;
    public string[]? Targets { get; init; }
    public int? IntervalDays { get; init; }
    public string? StartDate { get; init; }
    public string? Time { get; init; }
    public int? IntervalHours { get; init; }
    public int? StartHour { get; init; }
    public int? EndHour { get; init; }
    public int? Minute { get; init; }
    [JsonIgnore] public string Title => Name.Length == 0 ? Prompt ?? Command ?? "予定" : Name;
}
public sealed record SchedulesResponse { public required Schedule[] Schedules { get; init; } }
public sealed record AllSchedulesResponse { public required ScheduleSource[] Sources { get; init; } }
public sealed record ScheduleSource
{
    public required string Kind { get; init; }
    public required string Id { get; init; }
    public required string Name { get; init; }
    public required Schedule[] Schedules { get; init; }
    public ChatTarget Target => Kind switch { "bot" => new(Id, false), "room" => new(Id, true), _ => throw new BellApiException("予定の所有者を読み取れませんでした。") };
}
public sealed record ScheduleResponse { public required Schedule Schedule { get; init; } }
public sealed record ScheduledEntry(ChatTarget Target, string OwnerName, Schedule Schedule)
{
    public string Path => Target.Path + "/schedules/" + Uri.EscapeDataString(Schedule.Id);
}

public sealed class ScheduleDraft
{
    public string Name { get; set; } = "";
    public string Action { get; set; } = "prompt";
    public string Content { get; set; } = "";
    public string Frequency { get; set; } = "once";
    public DateTime Date { get; set; } = DateTime.Now.AddHours(1);
    public int Hour { get; set; } = 9;
    public int Minute { get; set; }
    public HashSet<int> Weekdays { get; set; } = [1];
    public string Expression { get; set; } = "0 9 * * 1-5";
    public int IntervalDays { get; set; } = 2;
    public DateTime StartDate { get; set; } = DateTime.Today;
    public int IntervalHours { get; set; } = 3;
    public int StartHour { get; set; } = 9;
    public int EndHour { get; set; } = 18;
    public string Timezone { get; set; } = LocalTimezone();
    public bool Enabled { get; set; } = true;
    public static string LocalTimezone()
    {
        var zone = TimeZoneInfo.Local;
        if (zone.HasIanaId) return zone.Id;
        if (TimeZoneInfo.TryConvertWindowsIdToIanaId(zone.Id, out var iana)) return iana;
        throw new ArgumentException("このPCのタイムゾーンをIANA名へ変換できません。");
    }
    public static ScheduleDraft From(Schedule item)
    {
        var draft = new ScheduleDraft { Name = item.Name, Action = item.Command is null ? "prompt" : "command", Content = item.Command ?? item.Prompt ?? "", Frequency = item.Kind, Enabled = item.Enabled,
            Expression = item.Expression ?? "", Timezone = item.Timezone ?? LocalTimezone(), IntervalDays = item.IntervalDays ?? 2, IntervalHours = item.IntervalHours ?? 3,
            StartHour = item.StartHour ?? 9, EndHour = item.EndHour ?? 18, Minute = item.Minute ?? 0 };
        if (item.At is { } at) draft.Date = DateTimeOffset.Parse(at, CultureInfo.InvariantCulture).LocalDateTime;
        if (item.StartDate is { } start) draft.StartDate = DateTime.ParseExact(start, "yyyy-MM-dd", CultureInfo.InvariantCulture);
        if (item.Time is { } time) { var parsed = TimeOnly.ParseExact(time, "HH:mm", CultureInfo.InvariantCulture); draft.Hour = parsed.Hour; draft.Minute = parsed.Minute; }
        return draft;
    }
    public Dictionary<string, object?> Payload(bool room, string[] targets)
    {
        if (string.IsNullOrWhiteSpace(Content)) throw new ArgumentException("実行内容を入力してください。");
        if (room && Action == "command") throw new ArgumentException("ルームではAIへの指示を選んでください。");
        var body = new Dictionary<string, object?> { ["name"] = Name.Trim(), ["kind"] = Frequency is "once" or "interval_days" or "interval_hours" ? Frequency : "cron", [Action] = TextContent.Normalize(Content), ["enabled"] = Enabled };
        if (room) body["targets"] = targets.Length == 0 ? null : targets;
        if (Frequency == "once") body["at"] = new DateTimeOffset(DateTime.SpecifyKind(Date, DateTimeKind.Local)).ToUniversalTime().ToString("O");
        else
        {
            body["timezone"] = Timezone;
            switch (Frequency)
            {
                case "interval_days": body["intervalDays"] = IntervalDays; body["startDate"] = StartDate.ToString("yyyy-MM-dd", CultureInfo.InvariantCulture); body["time"] = $"{Hour:00}:{Minute:00}"; break;
                case "interval_hours": body["intervalHours"] = IntervalHours; body["startHour"] = StartHour; body["endHour"] = EndHour; body["minute"] = Minute; break;
                case "weekly" when Weekdays.Count == 0: throw new ArgumentException("曜日を選んでください。");
                case "hourly": body["expression"] = $"{Minute} * * * *"; break;
                case "daily": body["expression"] = $"{Minute} {Hour} * * *"; break;
                case "weekly": body["expression"] = $"{Minute} {Hour} * * {string.Join(',', Weekdays.Order())}"; break;
                case "cron": body["expression"] = Expression.Trim(); break;
                default: throw new ArgumentException("予定の繰り返しが未対応です。");
            }
        }
        return body;
    }
}

public sealed record OwnerLink(string Label, string Url);
public sealed record OwnerProfile
{
    public required string Name { get; init; }
    public string Profile { get; init; } = "";
    public string Avatar { get; init; } = "";
    public string XUrl { get; init; } = "";
    public string GithubUrl { get; init; } = "";
    public OwnerLink[] Links { get; init; } = [];
    public Dictionary<string, object?> ChangesFrom(OwnerProfile before)
    {
        var changes = new Dictionary<string, object?>();
        if (Name != before.Name) changes["name"] = Name;
        if (TextContent.Normalize(Profile) != TextContent.Normalize(before.Profile)) changes["profile"] = TextContent.Normalize(Profile);
        if (Avatar != before.Avatar) changes["avatar"] = Avatar;
        if (XUrl != before.XUrl) changes["xUrl"] = XUrl;
        if (GithubUrl != before.GithubUrl) changes["githubUrl"] = GithubUrl;
        if (!Links.SequenceEqual(before.Links)) changes["links"] = Links;
        return changes;
    }
}
public sealed record OwnerResponse { public required OwnerProfile Owner { get; init; } }
public sealed record UserRulesResponse { public required string Text { get; init; } }

// 設定値は秘密の欄だけ読み捨てる。表示用モデルへ秘密の値を持たせない。
public sealed record FeatureField(string Key, string Label, bool Secret, string Value, bool Configured);
public sealed class FeatureSetting
{
    public required string Id { get; init; }
    public required string Title { get; init; }
    public bool Enabled { get; init; }
    public required string Status { get; init; }
    public required FeatureField[] Fields { get; init; }
    public bool ApplyFailed { get; init; }
    public string StatusText => ApplyFailed ? "反映エラー" : Status switch { "enabled" => "有効", "disabled" => "無効", _ => "未設定" };
    public static FeatureSetting Read(JsonElement value) => new()
    {
        Id = value.GetProperty("id").GetString()!, Title = value.GetProperty("title").GetString()!, Enabled = value.GetProperty("enabled").GetBoolean(), Status = value.GetProperty("status").GetString()!,
        ApplyFailed = value.TryGetProperty("error", out var error) && error.ValueKind != JsonValueKind.Null,
        Fields = value.GetProperty("fields").EnumerateArray().Select(field => new FeatureField(field.GetProperty("key").GetString()!, field.GetProperty("label").GetString()!, field.GetProperty("secret").GetBoolean(), field.GetProperty("secret").GetBoolean() ? "" : field.GetProperty("value").GetString()!, field.GetProperty("configured").GetBoolean())).ToArray()
    };
}
