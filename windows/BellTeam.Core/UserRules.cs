using System.Text.RegularExpressions;

namespace BellTeam.Core;

// The user rules text (GET /api/user-rules) read for display (Mac UserRulesDocument). The text stays the source of truth: this only splits the RULES format.
// shortcut: several clauses on one line stay one clause (the format does not say how they are separated); upgrade when it does.
public sealed class UserRulesDocument
{
    // The clause word as written, e.g. `DO`, `DEFAULT (codex)`. Value equality is deliberate: Details drops every clause equal to the headline, as the Mac does.
    public sealed record Clause(string Keyword, string Text)
    {
        public string Label
        {
            get
            {
                var word = Keyword.Split(' ')[0];
                var label = word switch
                {
                    "YOU" => "あなたは", "PURPOSE" => "目的", "FACT" => "前提", "WHEN" => "いつ", "DO" => "する", "MAY" => "してよい",
                    "NEVER" => "しない", "WHY" => "理由", "DEFAULT" => "既定", _ => Keyword
                };
                var open = Keyword.IndexOf('(');
                return word == "DEFAULT" && open >= 0 ? label + " " + Keyword[open..] : label;
            }
        }
    }

    public sealed class Rule(string id)
    {
        public string Id { get; } = id;
        public List<Clause> Clauses { get; } = [];
        // The clause that titles the rule's card: its PURPOSE, else its first clause. The id is never shown.
        public Clause? Headline => Clauses.FirstOrDefault(clause => clause.Keyword == "PURPOSE") ?? Clauses.FirstOrDefault();
        public IReadOnlyList<Clause> Details => Clauses.Where(clause => clause != Headline).ToArray();
    }

    public sealed class Section(string topic)
    {
        public string Topic { get; } = topic;
        public string? Note { get; set; }
        public List<Rule> Rules { get; } = [];
    }

    public List<Section> Sections { get; } = [];
    // Lines outside the format, shown as written.
    public List<string> PlainLines { get; } = [];

    public int RuleCount => Sections.Sum(section => section.Rules.Count);
    public bool IsEmpty => Sections.Count == 0 && PlainLines.Count == 0;

    private static readonly Regex ClausePattern = new(@"^(PURPOSE|FACT|WHEN|DO|MAY|NEVER|WHY|DEFAULT(?: \([^)]*\))?|YOU ARE):\s*(.*)$", RegexOptions.CultureInvariant);
    // CRLF counts as one break so a Windows-saved text keeps its indented continuations.
    private static readonly Regex Breaks = new("\r\n|[\n\r\v\f\u0085\u2028\u2029]");

    public static UserRulesDocument Parse(string text)
    {
        var document = new UserRulesDocument();
        var clauses = (List<Clause>?)null;
        var inRule = false;
        var inContinuation = false;
        // The format header's own `FORMAT` explanation (it quotes `SECTION <topic>`) runs until the first section or rule at column 0.
        var inFormat = false;
        foreach (var raw in Breaks.Split(text))
        {
            var line = raw.Trim();
            if (line.Length == 0) { inContinuation = false; continue; }
            if (inFormat)
            {
                if (raw.StartsWith("SECTION ", StringComparison.Ordinal) || raw.StartsWith("RULE ", StringComparison.Ordinal)) inFormat = false; else continue;
            }
            else if (line == "FORMAT" && document.Sections.Count == 0) { inFormat = true; continue; }
            if (line.StartsWith("SECTION ", StringComparison.Ordinal))
            {
                document.Sections.Add(new Section(line[8..].Trim()));
                inRule = false; inContinuation = false;
                continue;
            }
            if (line.StartsWith("RULE ", StringComparison.Ordinal))
            {
                var id = line[5..].Trim();
                if (document.Sections.Count == 0) document.Sections.Add(new Section(id.Split('.', 2)[0]));
                var rule = new Rule(id);
                document.Sections[^1].Rules.Add(rule);
                clauses = rule.Clauses;
                inRule = true; inContinuation = false;
                continue;
            }
            if (inRule && ClausePattern.Match(line) is { Success: true } match)
            {
                clauses!.Add(new Clause(match.Groups[1].Value, match.Groups[2].Value));
                inContinuation = true;
                continue;
            }
            // The format header line (`RULES … v1`) before the first section is not a rule.
            if (document.Sections.Count == 0 && line.StartsWith("RULES ", StringComparison.Ordinal)) continue;
            if (line.StartsWith('#') && inRule) continue;
            if (line.StartsWith('#') && document.Sections.Count != 0)
            {
                var note = line.TrimStart('#', ' ');
                var last = document.Sections[^1];
                last.Note = last.Note is null ? note : last.Note + " " + note;
                continue;
            }
            if (inRule && inContinuation && char.IsWhiteSpace(raw[0]))
            {
                var last = clauses![^1];
                clauses[^1] = last with { Text = last.Text + (last.Text.Length == 0 ? "" : " ") + line };
                continue;
            }
            document.PlainLines.Add(line);
            inContinuation = false;
        }
        return document;
    }
}
