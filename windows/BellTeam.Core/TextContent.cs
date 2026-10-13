namespace BellTeam.Core;

public static class TextContent
{
    public static string Normalize(string value) => value.Replace("\r\n", "\n").Replace('\r', '\n');
}
