using Windows.Networking.Connectivity;

namespace Vystral.Windows.Services;

/// <summary>What Windows says about the current internet connection's cost.</summary>
public sealed record NetworkCostDto(bool Connected, bool Metered, string CostType, bool Roaming, bool OverDataLimit, bool ApproachingDataLimit);

/// <summary>
/// Reads the connection cost Windows reports (Settings → Network → "Metered connection", mobile
/// data plans, roaming). Read-only; cached briefly and refreshed when the network changes.
/// </summary>
public sealed class NetworkCostService
{
    private static readonly TimeSpan CacheFor = TimeSpan.FromSeconds(30);
    private readonly Lock _lock = new();
    private NetworkCostDto? _cached;
    private DateTime _cachedAt;

    public NetworkCostService()
    {
        try { NetworkInformation.NetworkStatusChanged += _ => { lock (_lock) _cached = null; }; }
        catch (Exception ex) { Log.Warn("network", "Network change notifications unavailable", ex: ex); }
    }

    public NetworkCostDto Current
    {
        get
        {
            lock (_lock)
            {
                if (_cached is not null && DateTime.UtcNow - _cachedAt < CacheFor) return _cached;
            }
            var value = Read();
            lock (_lock)
            {
                _cached = value;
                _cachedAt = DateTime.UtcNow;
            }
            return value;
        }
    }

    /// <summary>
    /// Metered means Windows reports a fixed or variable (pay-per-use) plan, roaming, or a plan at its
    /// limit. "Unknown" and "Unrestricted" are treated as unmetered, as Windows itself does.
    /// </summary>
    public static bool IsMetered(string costType, bool roaming, bool overLimit, bool approachingLimit) =>
        costType is "Fixed" or "Variable" || roaming || overLimit || approachingLimit;

    private static NetworkCostDto Read()
    {
        try
        {
            var profile = NetworkInformation.GetInternetConnectionProfile();
            if (profile is null) return new NetworkCostDto(false, false, "None", false, false, false);
            var cost = profile.GetConnectionCost();
            var type = cost.NetworkCostType.ToString();
            return new NetworkCostDto(true, IsMetered(type, cost.Roaming, cost.OverDataLimit, cost.ApproachingDataLimit),
                type, cost.Roaming, cost.OverDataLimit, cost.ApproachingDataLimit);
        }
        catch (Exception ex)
        {
            // Unknown is safest to treat as unmetered: data saver remains available as a manual switch.
            Log.Warn("network", "Couldn't read the connection cost", ex: ex);
            return new NetworkCostDto(true, false, "Unknown", false, false, false);
        }
    }
}
