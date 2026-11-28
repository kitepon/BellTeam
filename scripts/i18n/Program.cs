// i18n step 1 extractor: every user-facing Japanese string literal in C# (and XAML) goes into a .resx catalog; the code calls a typed accessor.
//
//   dotnet run --project scripts/i18n -- <root> --resx <Strings.resx> --class <Accessor> --namespace <Ns> --resource <manifest name> [--exclude a,b] [--allow <allowlist.txt>] [--no-assembly-attr] [--prefix <repo-relative root>] [--apply]
//   dotnet run --project scripts/i18n -- <root> --annotate --resx <Strings.resx> --class <Accessor> --namespace <Ns> [--exclude a,b]      (writes where each text sits into the resx comments)
//   dotnet run --project scripts/i18n -- <root> --xaml --class <Accessor> --namespace <Ns> --resx <Strings.resx> [--apply]     (XAML attributes; run after the C# pass, sharing the resx)
//
// Without --apply nothing is written; the report is printed. The resx value of an entry is the exact old text, so under a ja UI the program prints byte-identical text.
// Skipped on purpose (the text is data, not display; a translated value would break the comparison): operands of ==/!=, patterns and case labels, attribute arguments,
// arguments of string search/compare APIs, indexer keys, parameter defaults. They are written to the allowlist as "<file>|<text>" lines.
using System.Globalization;
using System.Text;
using System.Text.RegularExpressions;
using System.Xml.Linq;
using Microsoft.CodeAnalysis;
using Microsoft.CodeAnalysis.CSharp;
using Microsoft.CodeAnalysis.CSharp.Syntax;

internal static class Program
{
    internal static readonly Regex Jp = new(@"[　-ヿ㐀-鿿＀-￯]", RegexOptions.Compiled);

    private static int Main(string[] args)
    {
        var o = Options.Parse(args);
        Rewriter.Cls = o.Class;
        var catalog = Catalog.Load(o.Resx);
        if (o.Annotate) { Annotator.Run(o, catalog, Files(o, "*.cs")); return 0; }
        var skipped = new List<string>();
        var manual = new List<string>();
        var changed = 0;
        if (o.Xaml)
        {
            foreach (var file in Files(o, "*.xaml")) changed += Xaml.Rewrite(file, o, catalog, manual);
        }
        else
        {
            foreach (var file in Files(o, "*.cs"))
            {
                var text = File.ReadAllText(file);
                var tree = CSharpSyntaxTree.ParseText(text, new CSharpParseOptions(LanguageVersion.Latest));
                var rewriter = new Rewriter(Path.GetFileNameWithoutExtension(file), o.Prefix + Path.GetRelativePath(o.Root, file).Replace('\\', '/'), catalog, skipped, manual);
                var root = rewriter.Visit(new SplitConsts().Visit(tree.GetRoot()));
                if (!rewriter.Changed) continue;
                changed++;
                if (o.Apply) File.WriteAllText(file, root.ToFullString());
            }
        }
        catalog.Report(o, changed, skipped, manual);
        if (o.Apply) { catalog.Save(o.Resx); catalog.WriteAccessor(o); if (o.Allow is not null) File.WriteAllLines(o.Allow, Merge(o.Allow, skipped)); }
        return 0;
    }

    // comment lines stay on top in their order; entries are sorted
    private static IEnumerable<string> Merge(string path, List<string> add)
    {
        var all = (File.Exists(path) ? File.ReadAllLines(path) : []).Where(l => l.Length > 0).ToList();
        return all.Where(l => l.StartsWith('#')).Concat(all.Where(l => !l.StartsWith('#')).Concat(add).Distinct().Order(StringComparer.Ordinal));
    }

    private static IEnumerable<string> Files(Options o, string pattern)
    {
        var excludes = o.Exclude.Select(g => new Regex("^" + Regex.Escape(g).Replace(@"\*", ".*") + "$")).ToList();
        foreach (var f in Directory.EnumerateFiles(o.Root, pattern, SearchOption.AllDirectories).Order(StringComparer.Ordinal))
        {
            var rel = Path.GetRelativePath(o.Root, f).Replace('\\', '/');
            if (rel.StartsWith("obj/") || rel.StartsWith("bin/") || rel.Contains("/obj/") || rel.Contains("/bin/")) continue;
            if (Path.GetFileName(f) == o.Class + ".cs") continue;
            if (excludes.Any(e => e.IsMatch(Path.GetFileName(f)) || e.IsMatch(rel))) continue;
            yield return f;
        }
    }
}

internal sealed record Options(string Root, string Resx, string Class, string Namespace, string Resource, string[] Exclude, string? Allow, bool Apply, bool Xaml, bool NoAssemblyAttr, string Prefix, bool Annotate)
{
    public static Options Parse(string[] a)
    {
        string? Get(string name) { var i = Array.IndexOf(a, name); return i >= 0 && i + 1 < a.Length ? a[i + 1] : null; }
        var root = a.FirstOrDefault(x => !x.StartsWith("--")) ?? throw new ArgumentException("root folder missing");
        return new(Path.GetFullPath(root), Path.GetFullPath(Get("--resx") ?? throw new ArgumentException("--resx")), Get("--class") ?? throw new ArgumentException("--class"),
            Get("--namespace") ?? throw new ArgumentException("--namespace"), Get("--resource") ?? "", (Get("--exclude") ?? "").Split(',', StringSplitOptions.RemoveEmptyEntries),
            Get("--allow") is { } al ? Path.GetFullPath(al) : null, a.Contains("--apply"), a.Contains("--xaml"), a.Contains("--no-assembly-attr"), Get("--prefix") ?? "", a.Contains("--annotate"));
    }
}

internal sealed class Entry(string key, string value, string comment) { public string Key = key; public string Value = value; public string Comment = comment; public int Arity; }

internal sealed class Catalog
{
    public readonly Dictionary<string, Entry> ByKey = new(StringComparer.Ordinal);
    private readonly Dictionary<string, Entry> byValue = new(StringComparer.Ordinal);
    public int Reused;

    public static Catalog Load(string path)
    {
        var c = new Catalog();
        if (!File.Exists(path)) return c;
        foreach (var d in XDocument.Load(path).Root!.Elements("data"))
        {
            var e = new Entry(d.Attribute("name")!.Value, d.Element("value")!.Value, d.Element("comment")?.Value ?? "");
            e.Arity = Regex.Matches(e.Comment, @"(?<!\{)\{(\d+)\} = ").Select(m => int.Parse(m.Groups[1].Value) + 1).DefaultIfEmpty(0).Max();
            c.ByKey[e.Key] = e; c.byValue[e.Value] = e;
        }
        return c;
    }

    // Same text, same placeholders: one entry (one translation, one glossary hit). Context-specific wording can be split later by giving a site its own key.
    public Entry Add(string baseKey, string value, string comment, int arity)
    {
        if (byValue.TryGetValue(value, out var existing)) { Reused++; return existing; }
        var key = baseKey; var n = 1;
        while (ByKey.ContainsKey(key)) key = baseKey + "_" + (++n);
        var e = new Entry(key, value, comment) { Arity = arity };
        ByKey[key] = e; byValue[value] = e;
        return e;
    }

    public void Save(string path)
    {
        Directory.CreateDirectory(Path.GetDirectoryName(path)!);
        var sb = new StringBuilder();
        sb.Append("<?xml version=\"1.0\" encoding=\"utf-8\"?>\n<root>\n");
        sb.Append("  <!-- Japanese source catalog (neutral language ja). Edit text here, never in code. Format entries use {0}, {1}: see each comment. Other languages: Strings.<culture>.resx. -->\n");
        sb.Append("  <resheader name=\"resmimetype\"><value>text/microsoft-resx</value></resheader>\n  <resheader name=\"version\"><value>2.0</value></resheader>\n");
        sb.Append("  <resheader name=\"reader\"><value>System.Resources.ResXResourceReader, System.Windows.Forms, Version=4.0.0.0, Culture=neutral, PublicKeyToken=b77a5c561934e089</value></resheader>\n");
        sb.Append("  <resheader name=\"writer\"><value>System.Resources.ResXResourceWriter, System.Windows.Forms, Version=4.0.0.0, Culture=neutral, PublicKeyToken=b77a5c561934e089</value></resheader>\n");
        foreach (var e in ByKey.Values.OrderBy(v => v.Key, StringComparer.Ordinal))
        {
            sb.Append("  <data name=\"").Append(e.Key).Append("\" xml:space=\"preserve\"><value>").Append(Esc(e.Value)).Append("</value>");
            if (e.Comment.Length > 0) sb.Append("<comment>").Append(Esc(e.Comment)).Append("</comment>");
            sb.Append("</data>\n");
        }
        sb.Append("</root>\n");
        File.WriteAllText(path, sb.ToString());
    }

    private static string Esc(string s) => s.Replace("&", "&amp;").Replace("<", "&lt;").Replace(">", "&gt;");

    public void WriteAccessor(Options o)
    {
        var sb = new StringBuilder();
        sb.Append("// <auto-generated>by scripts/i18n; the text lives in ").Append(Path.GetFileName(o.Resx)).Append(", edit it there and regenerate.</auto-generated>\n");
        sb.Append("#nullable enable\nusing System.Globalization;\nusing System.Resources;\n\n").Append(o.NoAssemblyAttr ? "" : "[assembly: NeutralResourcesLanguage(\"ja\")]\n\n").Append("namespace ").Append(o.Namespace).Append(";\n\n");
        sb.Append("internal static class ").Append(o.Class).Append("\n{\n");
        sb.Append("    private static readonly ResourceManager Manager = new(\"").Append(o.Resource).Append("\", typeof(").Append(o.Class).Append(").Assembly);\n");
        sb.Append("    private static string Get(string key) => Manager.GetString(key, CultureInfo.CurrentUICulture) ?? throw new InvalidOperationException(\"missing text \" + key);\n");
        foreach (var e in ByKey.Values.OrderBy(v => v.Key, StringComparer.Ordinal))
        {
            if (e.Arity == 0) sb.Append("    public static string ").Append(e.Key).Append(" => Get(\"").Append(e.Key).Append("\");\n");
            else
            {
                var ps = string.Join(", ", Enumerable.Range(0, e.Arity).Select(i => "object? a" + i));
                var xs = string.Join(", ", Enumerable.Range(0, e.Arity).Select(i => "a" + i));
                sb.Append("    public static string ").Append(e.Key).Append('(').Append(ps).Append(") => string.Format(CultureInfo.CurrentCulture, Get(\"").Append(e.Key).Append("\"), ").Append(xs).Append(");\n");
            }
        }
        sb.Append("}\n");
        File.WriteAllText(Path.Combine(Path.GetDirectoryName(o.Resx)!, o.Class + ".cs"), sb.ToString());
    }

    public void Report(Options o, int files, List<string> skipped, List<string> manual)
    {
        Console.WriteLine($"files changed: {files}; catalog entries: {ByKey.Count} (reused by identical text: {Reused}); skipped as data: {skipped.Count}; for hand fixing: {manual.Count}; apply: {o.Apply}");
        foreach (var m in manual) Console.WriteLine("MANUAL " + m);
    }
}

internal sealed class Rewriter(string fileStem, string relPath, Catalog catalog, List<string> skipped, List<string> manual) : CSharpSyntaxRewriter
{
    public bool Changed;
    private readonly Dictionary<string, int> counters = [];
    private static readonly HashSet<string> CompareApis = ["Equals", "StartsWith", "EndsWith", "Contains", "IndexOf", "LastIndexOf", "Split", "Trim", "TrimStart", "TrimEnd", "Replace", "CompareTo", "Compare", "IsNullOrEmpty"];

    // ---- skip contexts: the text is compared or looked up, never shown
    private string? SkipReason(SyntaxNode node)
    {
        for (SyntaxNode? n = node, p = node.Parent; p is not null; n = p, p = p.Parent)
        {
            switch (p)
            {
                case AttributeArgumentSyntax: return "attribute argument";
                case PatternSyntax: return "pattern";
                case CaseSwitchLabelSyntax: return "case label";
                case BinaryExpressionSyntax b when b.IsKind(SyntaxKind.EqualsExpression) || b.IsKind(SyntaxKind.NotEqualsExpression): return "equality operand";
                case ElementAccessExpressionSyntax: return "indexer key";
                case BracketedArgumentListSyntax: return "indexer key";
                case ParameterSyntax: return "parameter default";
                case ArgumentSyntax a when a.Parent?.Parent is InvocationExpressionSyntax inv && inv.Expression is MemberAccessExpressionSyntax m && CompareApis.Contains(m.Name.Identifier.Text) && n == a: return "compare/search API argument";
                case ArgumentSyntax a3 when a3.Parent?.Parent is InvocationExpressionSyntax inv3 && inv3.Expression is MemberAccessExpressionSyntax rm && rm.ToString().Contains("Regex"): return "regular expression";
                case ArgumentSyntax a4 when a4.Parent?.Parent is ObjectCreationExpressionSyntax oc && oc.Type.ToString().EndsWith("Regex"): return "regular expression";
                case ArgumentSyntax a2 when a2.Parent?.Parent is InvocationExpressionSyntax inv2 && inv2.Expression is IdentifierNameSyntax id && id.Identifier.Text is "nameof": return "nameof";
                case ThrowExpressionSyntax: return null;
                case StatementSyntax: return null;
            }
            if (p is MemberDeclarationSyntax) return null;
        }
        return null;
    }

    private string MemberName(SyntaxNode node)
    {
        for (var p = node.Parent; p is not null; p = p.Parent)
            switch (p)
            {
                case MethodDeclarationSyntax m: return m.Identifier.Text;
                case ConstructorDeclarationSyntax c: return c.Identifier.Text;
                case PropertyDeclarationSyntax pr: return pr.Identifier.Text;
                case VariableDeclaratorSyntax v when v.Parent?.Parent is FieldDeclarationSyntax: return v.Identifier.Text;
                case TypeDeclarationSyntax t: return t.Identifier.Text;
            }
        return "File";
    }

    private static string Ident(string s) { var r = Regex.Replace(s, "[^A-Za-z0-9_]", "_"); return r.Length == 0 || char.IsDigit(r[0]) ? "_" + r : r; }

    private ExpressionSyntax Make(SyntaxNode origin, string value, string comment, List<ExpressionSyntax> args)
    {
        var member = MemberName(origin);
        var baseKey = Ident(fileStem + "_" + member);
        counters[baseKey] = counters.GetValueOrDefault(baseKey) + 1;
        var entry = catalog.Add(baseKey + "_" + counters[baseKey], value, comment, args.Count);
        Changed = true;
        var cls = SyntaxFactory.IdentifierName(Cls);
        var access = SyntaxFactory.MemberAccessExpression(SyntaxKind.SimpleMemberAccessExpression, cls, SyntaxFactory.IdentifierName(entry.Key));
        ExpressionSyntax result = args.Count == 0 ? access : SyntaxFactory.InvocationExpression(access, SyntaxFactory.ArgumentList(SyntaxFactory.SeparatedList(args.Select(a => SyntaxFactory.Argument(a)), Enumerable.Repeat(SyntaxFactory.Token(SyntaxKind.CommaToken).WithTrailingTrivia(SyntaxFactory.Space), Math.Max(0, args.Count - 1)))));
        return result.WithLeadingTrivia(origin.GetLeadingTrivia()).WithTrailingTrivia(origin.GetTrailingTrivia());
    }

    public static string Cls = "Strings";
    private static bool IsRaw(InterpolatedStringExpressionSyntax n) => n.StringStartToken.IsKind(SyntaxKind.InterpolatedSingleLineRawStringStartToken) || n.StringStartToken.IsKind(SyntaxKind.InterpolatedMultiLineRawStringStartToken);

    private static string Brace(string s) => s.Replace("{", "{{").Replace("}", "}}");

    // ---- plain literal
    public override SyntaxNode? VisitLiteralExpression(LiteralExpressionSyntax node)
    {
        if (!node.IsKind(SyntaxKind.StringLiteralExpression) || !Program.Jp.IsMatch(node.Token.ValueText)) return base.VisitLiteralExpression(node);
        if (SkipReason(node) is { } why) { skipped.Add(relPath + "|" + node.Token.ValueText); _ = why; return node; }
        return Make(node, node.Token.ValueText, "", []);
    }

    // ---- $"...{x}..."
    public override SyntaxNode? VisitInterpolatedStringExpression(InterpolatedStringExpressionSyntax node)
    {
        if (IsRaw(node)) { if (Program.Jp.IsMatch(node.ToString())) manual.Add($"{relPath}:{Line(node)} raw interpolated string"); return node; }
        var text = new StringBuilder(); var args = new List<ExpressionSyntax>(); var comment = new StringBuilder();
        if (!AppendInterpolated(node, text, args, comment) || !Program.Jp.IsMatch(text.ToString())) return base.VisitInterpolatedStringExpression(node);
        if (SkipReason(node) is { } why) { skipped.Add(relPath + "|" + text); _ = why; return node; }
        return Make(node, text.ToString(), comment.ToString(), args);
    }

    private bool AppendInterpolated(InterpolatedStringExpressionSyntax node, StringBuilder text, List<ExpressionSyntax> args, StringBuilder comment)
    {
        foreach (var c in node.Contents)
        {
            switch (c)
            {
                case InterpolatedStringTextSyntax t: text.Append(Brace(t.TextToken.ValueText)); break;
                case InterpolationSyntax i:
                    var index = args.Count;
                    args.Add((ExpressionSyntax)Visit(i.Expression)!.WithoutTrivia());
                    comment.Append('{').Append(index).Append("} = ").Append(Short(i.Expression)).Append("; ");
                    text.Append('{').Append(index);
                    if (i.AlignmentClause is { } al) text.Append(',').Append(al.Value);
                    if (i.FormatClause is { } f) text.Append(':').Append(f.FormatStringToken.ValueText);
                    text.Append('}');
                    break;
            }
        }
        return true;
    }

    private static string Short(ExpressionSyntax e) { var s = Regex.Replace(e.ToString(), @"\s+", " "); return s.Length > 50 ? s[..50] + "..." : s; }
    private int Line(SyntaxNode n) => n.GetLocation().GetLineSpan().StartLinePosition.Line + 1;

    // ---- "a" + x + "b"  (a + node is string concatenation as soon as one operand is a string literal / interpolated string / another such node)
    private static bool IsText(ExpressionSyntax e) => e switch
    {
        LiteralExpressionSyntax l => l.IsKind(SyntaxKind.StringLiteralExpression),
        InterpolatedStringExpressionSyntax => true,
        ParenthesizedExpressionSyntax => false,
        BinaryExpressionSyntax b when b.IsKind(SyntaxKind.AddExpression) => IsText(b.Left) || IsText(b.Right),
        _ => false,
    };

    public override SyntaxNode? VisitBinaryExpression(BinaryExpressionSyntax node)
    {
        if (!node.IsKind(SyntaxKind.AddExpression) || !IsText(node) || (node.Parent is BinaryExpressionSyntax pb && pb.IsKind(SyntaxKind.AddExpression))) return base.VisitBinaryExpression(node);
        var leaves = new List<ExpressionSyntax>(); Flatten(node, leaves);
        var text = new StringBuilder(); var args = new List<ExpressionSyntax>(); var comment = new StringBuilder();
        foreach (var leaf in leaves)
        {
            switch (leaf)
            {
                case LiteralExpressionSyntax l when l.IsKind(SyntaxKind.StringLiteralExpression): text.Append(Brace(l.Token.ValueText)); break;
                case InterpolatedStringExpressionSyntax s when !IsRaw(s):
                    var inner = new StringBuilder(); var innerArgs = new List<ExpressionSyntax>(); var innerComment = new StringBuilder();
                    AppendInterpolated(s, inner, innerArgs, innerComment);
                    // renumber the inner placeholders after the ones already taken
                    text.Append(Regex.Replace(inner.ToString(), @"(?<!\{)\{(\d+)", m => "{" + (int.Parse(m.Groups[1].Value) + args.Count)));
                    foreach (var a in innerArgs) { comment.Append('{').Append(args.Count).Append("} = ").Append(Short(a)).Append("; "); args.Add(a); }
                    break;
                default:
                    comment.Append('{').Append(args.Count).Append("} = ").Append(Short(leaf)).Append("; ");
                    text.Append('{').Append(args.Count).Append('}');
                    args.Add((ExpressionSyntax)Visit(leaf)!.WithoutTrivia());
                    break;
            }
        }
        if (!Program.Jp.IsMatch(text.ToString())) return base.VisitBinaryExpression(node);
        if (SkipReason(node) is { } why) { skipped.Add(relPath + "|" + text); _ = why; return node; }
        // a char operand would print as its character in a concatenation and as the same character through string.Format: unchanged
        return Make(node, text.ToString(), comment.ToString(), args);
    }

    private static void Flatten(ExpressionSyntax e, List<ExpressionSyntax> into)
    {
        if (e is BinaryExpressionSyntax b && b.IsKind(SyntaxKind.AddExpression) && IsText(b)) { Flatten(b.Left, into); Flatten(b.Right, into); }
        else into.Add(e);
    }

    // ---- const string X = "..." becomes a static property; a const local becomes a plain local
    public override SyntaxNode? VisitFieldDeclaration(FieldDeclarationSyntax node)
    {
        if (!node.Modifiers.Any(SyntaxKind.ConstKeyword) || !Program.Jp.IsMatch(node.ToString())) return base.VisitFieldDeclaration(node);
        if (node.Declaration.Variables.Count != 1 || node.Declaration.Variables[0].Initializer is not { } init) { manual.Add($"{relPath}:{Line(node)} const with several declarators"); return node; }
        var value = (ExpressionSyntax)Visit(init.Value)!;
        if (ReferenceEquals(value, init.Value)) return node;   // skipped as data
        var mods = SyntaxFactory.TokenList(node.Modifiers.Where(m => !m.IsKind(SyntaxKind.ConstKeyword)).Append(SyntaxFactory.Token(SyntaxKind.StaticKeyword).WithTrailingTrivia(SyntaxFactory.Space)));
        var prop = SyntaxFactory.PropertyDeclaration(node.Declaration.Type.WithoutTrivia().WithTrailingTrivia(SyntaxFactory.Space), node.Declaration.Variables[0].Identifier.WithTrailingTrivia(SyntaxFactory.Space))
            .WithAttributeLists(node.AttributeLists).WithModifiers(mods)
            .WithExpressionBody(SyntaxFactory.ArrowExpressionClause(value.WithLeadingTrivia(SyntaxFactory.Space)).WithLeadingTrivia(SyntaxFactory.Space))
            .WithSemicolonToken(SyntaxFactory.Token(SyntaxKind.SemicolonToken)).WithLeadingTrivia(node.GetLeadingTrivia()).WithTrailingTrivia(node.GetTrailingTrivia());
        Changed = true;
        return prop;
    }

    public override SyntaxNode? VisitLocalDeclarationStatement(LocalDeclarationStatementSyntax node)
    {
        var r = (LocalDeclarationStatementSyntax)base.VisitLocalDeclarationStatement(node)!;
        if (!node.Modifiers.Any(SyntaxKind.ConstKeyword) || ReferenceEquals(r, node) || !r.ToString().Contains(Cls + ".")) return r;
        return r.WithModifiers(SyntaxFactory.TokenList(r.Modifiers.Where(m => !m.IsKind(SyntaxKind.ConstKeyword)))).WithLeadingTrivia(node.GetLeadingTrivia());
    }
}

// Where each catalog text sits, for the translation step (the original layout never changes: text must fit by shorter wording, font size or the wraps the element already has).
// Static facts only: file:line, member, the call or property that receives the text and the numeric arguments next to it (font size, MaxWidth, MaxLines...). Measured widths are not here.
internal static class Annotator
{
    public static void Run(Options o, Catalog catalog, IEnumerable<string> files)
    {
        var sites = new Dictionary<string, List<string>>(StringComparer.Ordinal);
        foreach (var file in files)
        {
            var rel = Path.GetRelativePath(o.Root, file).Replace('\\', '/');
            var root = CSharpSyntaxTree.ParseText(File.ReadAllText(file)).GetRoot();
            foreach (var use in root.DescendantNodes().OfType<MemberAccessExpressionSyntax>())
            {
                if (use.Expression is not IdentifierNameSyntax cls || cls.Identifier.Text != o.Class || !catalog.ByKey.ContainsKey(use.Name.Identifier.Text)) continue;
                var key = use.Name.Identifier.Text;
                SyntaxNode node = use.Parent is InvocationExpressionSyntax inv && inv.Expression == use ? inv : use;
                var line = use.GetLocation().GetLineSpan().StartLinePosition.Line + 1;
                var list = sites.TryGetValue(key, out var l) ? l : sites[key] = [];
                list.Add($"{rel}:{line} {Member(node)}: {Host(node)}");
            }
        }
        foreach (var e in catalog.ByKey.Values)
        {
            var baseComment = e.Comment.Contains(" | sites: ") ? e.Comment[..e.Comment.IndexOf(" | sites: ", StringComparison.Ordinal)] : e.Comment;
            var shown = sites.TryGetValue(e.Key, out var s) ? s.Distinct().Take(4).ToList() : [];
            var more = sites.TryGetValue(e.Key, out var s2) && s2.Distinct().Count() > 4 ? $" (+{s2.Distinct().Count() - 4} more)" : "";
            e.Comment = baseComment + " | sites: " + (shown.Count == 0 ? "none in code (pattern or not used)" : string.Join(" ; ", shown) + more) + " | ja chars: " + e.Value.Length;
        }
        catalog.Save(o.Resx);
        Console.WriteLine($"annotated {catalog.ByKey.Count} entries from {sites.Count} used keys");
    }

    private static string Member(SyntaxNode n) => n.Ancestors().Select(a => a switch { MethodDeclarationSyntax m => m.Identifier.Text, ConstructorDeclarationSyntax c => c.Identifier.Text, PropertyDeclarationSyntax p => p.Identifier.Text, VariableDeclaratorSyntax { Parent.Parent: FieldDeclarationSyntax } v => v.Identifier.Text, _ => null }).FirstOrDefault(x => x is not null) ?? "-";

    // the control or call that receives the text, and the plain numbers/properties next to it
    private static string Host(SyntaxNode node)
    {
        for (var p = node.Parent; p is not null; p = p.Parent)
        {
            switch (p)
            {
                case AssignmentExpressionSyntax a when a.Right.FullSpan.Contains(node.Span): return a.Left + " = ...; " + Props(a.Parent?.Parent as InitializerExpressionSyntax ?? a.Parent as InitializerExpressionSyntax);
                case ArgumentSyntax arg when arg.Parent?.Parent is InvocationExpressionSyntax call && !call.ToString().StartsWith("string.Format"): return call.Expression.ToString().Split('.').Last() + "(" + Numbers(call.ArgumentList) + ")";
                case ArgumentSyntax arg2 when arg2.Parent?.Parent is ObjectCreationExpressionSyntax oc: return "new " + oc.Type + "(" + (oc.ArgumentList is { } al ? Numbers(al) : "") + ")" + (oc.Initializer is { } ini ? " " + Props(ini) : "");
                case ObjectCreationExpressionSyntax oc2 when oc2.Initializer is { } ini2: return "new " + oc2.Type + " " + Props(ini2);
                case StatementSyntax: return "statement";
            }
        }
        return "-";
    }

    private static string Numbers(ArgumentListSyntax args) => string.Join(",", args.Arguments.Select(a => a.Expression).OfType<LiteralExpressionSyntax>().Where(l => l.IsKind(SyntaxKind.NumericLiteralExpression)).Select(l => l.Token.Text));

    private static readonly HashSet<string> Interesting = ["FontSize", "MaxWidth", "Width", "MinWidth", "MaxLines", "MaxHeight", "Height", "MinHeight", "TextWrapping", "TextTrimming", "HorizontalAlignment", "Padding", "Margin"];
    private static string Props(InitializerExpressionSyntax? ini) => ini is null ? "" : "{" + string.Join(", ", ini.Expressions.OfType<AssignmentExpressionSyntax>().Where(a => Interesting.Contains(a.Left.ToString())).Select(a => a.ToString().Replace("\n", " "))) + "}";
}

// const string A = "x", B = "y"; becomes one declaration each, so every const can turn into its own property.
internal sealed class SplitConsts : CSharpSyntaxRewriter
{
    private static SyntaxList<MemberDeclarationSyntax> Split(SyntaxList<MemberDeclarationSyntax> members)
    {
        var list = new List<MemberDeclarationSyntax>();
        foreach (var m in members)
        {
            if (m is FieldDeclarationSyntax { Declaration.Variables.Count: > 1 } fd && fd.Modifiers.Any(SyntaxKind.ConstKeyword))
            {
                var first = true;
                foreach (var v in fd.Declaration.Variables)
                {
                    var one = fd.WithDeclaration(fd.Declaration.WithVariables(SyntaxFactory.SingletonSeparatedList(v.WithoutTrivia())));
                    list.Add(first ? one.WithTrailingTrivia(SyntaxFactory.LineFeed) : one.WithLeadingTrivia(fd.GetLeadingTrivia().Where(t => t.IsKind(SyntaxKind.WhitespaceTrivia))).WithTrailingTrivia(SyntaxFactory.LineFeed));
                    first = false;
                }
            }
            else list.Add(m);
        }
        return SyntaxFactory.List(list);
    }
    public override SyntaxNode? VisitClassDeclaration(ClassDeclarationSyntax node) { var n = (ClassDeclarationSyntax)base.VisitClassDeclaration(node)!; return n.WithMembers(Split(n.Members)); }
    public override SyntaxNode? VisitStructDeclaration(StructDeclarationSyntax node) { var n = (StructDeclarationSyntax)base.VisitStructDeclaration(node)!; return n.WithMembers(Split(n.Members)); }
    public override SyntaxNode? VisitRecordDeclaration(RecordDeclarationSyntax node) { var n = (RecordDeclarationSyntax)base.VisitRecordDeclaration(node)!; return n.WithMembers(Split(n.Members)); }
}

// XAML: Attr="日本語" becomes Attr="{x:Static i18n:Accessor.Key}"; element text and anything else is listed for hand fixing.
internal static class Xaml
{
    public static int Rewrite(string file, Options o, Catalog catalog, List<string> manual)
    {
        var text = File.ReadAllText(file); var n = 0; var stem = Path.GetFileNameWithoutExtension(file);
        var rel = Path.GetRelativePath(o.Root, file).Replace('\\', '/');
        var result = Regex.Replace(text, "(?<name>[A-Za-z:.]+)=\"(?<v>[^\"{][^\"]*)\"", m =>
        {
            var v = System.Net.WebUtility.HtmlDecode(m.Groups["v"].Value);
            var name = m.Groups["name"].Value;
            if (!Program.Jp.IsMatch(v) || name is "x:Name" or "Name" or "x:Uid" or "xmlns" || name.StartsWith("xmlns")) return m.Value;
            n++;
            var e = catalog.Add(Regex.Replace(stem, "[^A-Za-z0-9]", "_") + "_" + name.Replace(':', '_').Replace('.', '_') + "_1", v, "", 0);
            return name + "=\"{x:Static i18n:" + o.Class + "." + e.Key + "}\"";
        });
        if (n > 0 && !result.Contains("xmlns:i18n=")) result = Regex.Replace(result, @"(<[A-Za-z:.]+)(\s)", m => m.Groups[1].Value + " xmlns:i18n=\"clr-namespace:" + o.Namespace + "\"" + m.Groups[2].Value, RegexOptions.None, TimeSpan.FromSeconds(1)).Length > 0 ? new Regex(@"(<[A-Za-z:.]+)(\s)").Replace(result, m => m.Groups[1].Value + " xmlns:i18n=\"clr-namespace:" + o.Namespace + "\"" + m.Groups[2].Value, 1) : result;
        foreach (Match m in Regex.Matches(result, @">([^<>{]*[　-ヿ㐀-鿿＀-￯][^<>]*)<")) manual.Add($"{rel} element text: {m.Groups[1].Value.Trim()}");
        if (n > 0 && o.Apply) File.WriteAllText(file, result);
        return n > 0 ? 1 : 0;
    }
}
