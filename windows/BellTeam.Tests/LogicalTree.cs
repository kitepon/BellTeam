using System.Windows;

namespace BellTeam.Tests;

// Cards are built in code and never shown, so tests read them through the logical tree.
internal static class LogicalTree
{
    public static IEnumerable<T> Find<T>(object? root) where T : class
    {
        if (root is T match) yield return match;
        if (root is not DependencyObject element) yield break;
        foreach (var child in LogicalTreeHelper.GetChildren(element)) foreach (var nested in Find<T>(child)) yield return nested;
    }
}
