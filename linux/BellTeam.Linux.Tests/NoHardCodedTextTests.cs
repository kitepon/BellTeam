using System.Text.RegularExpressions;
using Microsoft.CodeAnalysis;
using Microsoft.CodeAnalysis.CSharp;

namespace BellTeam.Linux;

// i18n step 1 guard: user-facing text lives in the Strings.resx catalogs, never in code. A new Japanese literal fails here.
// Move it into the catalog (scripts/i18n extracts it: see scripts/i18n/Program.cs) or, for text that is data and never shown, add "<file>|<text>" (or "file:<glob>|<reason>")
// to scripts/i18n/allowlist.txt with the reason in a # line above it.
public class NoHardCodedTextTests
{
    private static readonly string[] Roots = ["windows/BellTeam.Core", "windows/BellTeam.App", "linux/BellTeam.Linux", "android/BellTeam.Android"];
    private static readonly Regex Jp = new(@"[　-ヿ㐀-鿿＀-￯]");

    internal static IEnumerable<string> Find(string path, string source)
    {
        var tokens = CSharpSyntaxTree.ParseText(source).GetRoot().DescendantTokens();
        foreach (var token in tokens)
            if (token.Kind() is SyntaxKind.StringLiteralToken or SyntaxKind.CharacterLiteralToken or SyntaxKind.InterpolatedStringTextToken or SyntaxKind.SingleLineRawStringLiteralToken or SyntaxKind.MultiLineRawStringLiteralToken && Jp.IsMatch(token.ValueText))
                yield return path + "|" + token.ValueText;
    }

    private static string RepoRoot()
    {
        for (var dir = new DirectoryInfo(AppContext.BaseDirectory); dir is not null; dir = dir.Parent)
            if (Directory.Exists(Path.Combine(dir.FullName, "windows", "BellTeam.Core")) && Directory.Exists(Path.Combine(dir.FullName, "scripts", "i18n"))) return dir.FullName;
        throw new DirectoryNotFoundException("repository root not found from " + AppContext.BaseDirectory);
    }

    [Fact]
    public void NoUserFacingJapaneseLiteralIsInCode()
    {
        var root = RepoRoot();
        var lines = File.ReadAllLines(Path.Combine(root, "scripts", "i18n", "allowlist.txt")).Where(l => l.Length > 0 && !l.StartsWith('#')).ToList();
        var allowedText = lines.Where(l => !l.StartsWith("file:")).ToHashSet();
        var allowedFiles = lines.Where(l => l.StartsWith("file:")).Select(l => new Regex("^" + Regex.Escape(l[5..l.IndexOf('|')]).Replace(@"\*", "[^/]*") + "$")).ToList();
        var found = new List<string>();
        foreach (var rootDir in Roots)
            foreach (var file in Directory.EnumerateFiles(Path.Combine(root, rootDir), "*.cs", SearchOption.AllDirectories))
            {
                var rel = Path.GetRelativePath(root, file).Replace('\\', '/');
                if (rel.Contains("/obj/") || rel.Contains("/bin/") || allowedFiles.Any(g => g.IsMatch(rel))) continue;
                found.AddRange(Find(rel, File.ReadAllText(file)).Where(f => !allowedText.Contains(f)));
            }
        Assert.True(found.Count == 0, "Japanese text in code (move it to the Strings.resx catalog, see scripts/i18n):\n" + string.Join("\n", found.Take(30)));
    }

    [Fact]
    public void ThePlantedLiteralsAreSeenAndCommentsAreNot()
    {
        var seen = Find("x.cs", "class A { string a = \"日本語\"; string b = $\"は{1}です\"; char c = '・'; // コメント\n /* 説明 */ string d = \"ok\"; }").ToList();
        Assert.Equal(["x.cs|日本語", "x.cs|は", "x.cs|です", "x.cs|・"], seen);
    }
}
