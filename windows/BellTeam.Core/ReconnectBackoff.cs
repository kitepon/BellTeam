namespace BellTeam.Core;

// Same schedule as Web (work-graph-model.js backoffMs) and the Mac: now, 1, 2, 4, 8, then 15 s (each +-20% jitter), never giving up.
public static class ReconnectBackoff
{
    public static readonly TimeSpan StableConnection = TimeSpan.FromSeconds(30);
    private static readonly int[] StepsMs = [1000, 2000, 4000, 8000];
    public static int Ms(int attempt, Func<double>? random = null)
        => attempt <= 0 ? 0 : (int)Math.Round((attempt <= StepsMs.Length ? StepsMs[attempt - 1] : 15000) * (0.8 + 0.4 * (random ?? Random.Shared.NextDouble)()), MidpointRounding.AwayFromZero);
}
