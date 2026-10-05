namespace Vystral.Windows.Services.NetworkHealth;

/// <summary>One resolved address of a service and whether a TCP connection to it worked.</summary>
public sealed record AddressCheck(string Address, string Family, bool Reachable, int? Ms, string? Error);

/// <summary>Everything one probe saw. Built by <see cref="NetworkHealthService"/>, judged by <see cref="HealthClassifier"/>.</summary>
public sealed record HealthObservation
{
    public required string Host { get; init; }
    public string? DnsError { get; init; }
    public IReadOnlyList<AddressCheck> Addresses { get; init; } = [];
    public int? HttpStatus { get; init; }
    public int? HttpMs { get; init; }
    public NetworkFailure? HttpFailure { get; init; }
    public IReadOnlyDictionary<string, string> Headers { get; init; } = new Dictionary<string, string>();
    /// <summary>For CDNs: any HTTP answer, even 403/404 for a bare URL, proves they're reachable.</summary>
    public bool AnyResponseIsHealthy { get; init; }
    public double TimeoutSeconds { get; init; } = 10;
    public DateTimeOffset Now { get; init; } = DateTimeOffset.UtcNow;
}

/// <summary>ok (green) · warn (amber, works with a caveat) · down (red) · skipped (grey).</summary>
public sealed record HealthVerdict(string Status, string Summary, string? Detail = null);

/// <summary>
/// Pure judgement of a probe's observation into a status and the actual reason in plain words,
/// e.g. "One of github.com's addresses (185.199.109.133) isn't reachable from this network;
/// VYSTRAL uses the others", "Slow: 1.8 s", "Rate limited (HTTP 429) — resets in 12 min".
/// </summary>
public static class HealthClassifier
{
    public const int SlowMs = 1500;

    public static HealthVerdict Classify(HealthObservation o)
    {
        var reachable = o.Addresses.Where(a => a.Reachable).ToList();
        var unreachable = o.Addresses.Where(a => !a.Reachable).ToList();

        if (o.DnsError is not null && o.Addresses.Count == 0 && o.HttpStatus is null)
            return new("down", $"DNS failed: {o.Host} couldn't be looked up", o.DnsError);

        if (o.HttpStatus is null)
        {
            if (o.Addresses.Count > 0 && reachable.Count == 0)
                return new("down",
                    o.Addresses.Count == 1
                        ? $"{o.Host} ({o.Addresses[0].Address}) isn't reachable from this network"
                        : $"None of {o.Host}'s {o.Addresses.Count} addresses answered",
                    "A firewall, VPN or the network itself may be blocking it, or this PC is offline.");
            var f = o.HttpFailure ?? new NetworkFailure("other", "The connection failed");
            return f.Kind switch
            {
                "timeout" => new("down", $"Timed out after {o.TimeoutSeconds:0} s", f.Text),
                "dns" => new("down", $"DNS failed: {o.Host} couldn't be looked up", f.Text),
                "tls" => new("down", "TLS error", f.Text),
                _ => new("down", f.Text),
            };
        }

        var status = o.HttpStatus.Value;
        var reset = RateLimitReset(o);
        var resetText = reset is { } r ? $" — resets in {NetworkErrors.Duration(r)}" : "";
        if (status == 429 || (status == 403 && Header(o, "x-ratelimit-remaining") == "0"))
            return new("warn", $"Rate limited (HTTP {status}){resetText}", "VYSTRAL waits and tries again later. Nothing else is affected.");
        if (status >= 500)
            return new("down", $"The service has a problem (HTTP {status})", "It's on their side; VYSTRAL tries again later.");
        if (status >= 400 && !o.AnyResponseIsHealthy)
        {
            var f = NetworkErrors.FromStatus(status);
            return new("warn", f.Text, status == 403 ? "The service refused the request from this network." : null);
        }

        if (int.TryParse(Header(o, "x-ratelimit-remaining"), out var left) && int.TryParse(Header(o, "x-ratelimit-limit"), out var limit) && left < Math.Min(10, limit))
            return new("warn", $"Only {left} of {limit} requests left this hour{resetText}", "GitHub limits how often a network can ask. Update checks pause until it resets.");

        // Some addresses failed. A network without IPv6 failing every IPv6 address is normal.
        var ipv6Only = unreachable.Count > 0 && unreachable.All(a => a.Family == "IPv6") && o.Addresses.Where(a => a.Family == "IPv6").All(a => !a.Reachable) && reachable.Count > 0;
        string? note = ipv6Only ? "This network has no IPv6; IPv4 works." : null;
        if (unreachable.Count > 0 && !ipv6Only)
        {
            var list = string.Join(", ", unreachable.Take(3).Select(a => a.Address)) + (unreachable.Count > 3 ? ", …" : "");
            var summary = unreachable.Count == 1
                ? $"One of {o.Host}'s addresses ({list}) isn't reachable from this network; VYSTRAL uses the others"
                : $"{unreachable.Count} of {o.Host}'s {o.Addresses.Count} addresses ({list}) aren't reachable from this network; VYSTRAL uses the others";
            return new("warn", summary, Timing(o));
        }

        if (o.HttpMs is > SlowMs)
            return new("warn", $"Slow: {o.HttpMs.Value / 1000.0:0.0} s", note ?? "It works, just slowly. Downloads may take longer.");

        return new("ok", o.HttpMs is { } ms ? $"OK · {ms} ms" : "OK", note);
    }

    private static string? Timing(HealthObservation o) => o.HttpMs is { } ms ? $"Answered in {ms} ms." : null;

    private static string? Header(HealthObservation o, string name) =>
        o.Headers.FirstOrDefault(h => string.Equals(h.Key, name, StringComparison.OrdinalIgnoreCase)).Value;

    /// <summary>From GitHub's X-RateLimit-Reset (Unix seconds) or a standard Retry-After (seconds).</summary>
    internal static TimeSpan? RateLimitReset(HealthObservation o)
    {
        if (long.TryParse(Header(o, "x-ratelimit-reset"), out var epoch))
        {
            var left = DateTimeOffset.FromUnixTimeSeconds(epoch) - o.Now;
            return left > TimeSpan.Zero ? left : TimeSpan.FromSeconds(1);
        }
        if (int.TryParse(Header(o, "retry-after"), out var seconds) && seconds > 0) return TimeSpan.FromSeconds(seconds);
        return null;
    }
}
