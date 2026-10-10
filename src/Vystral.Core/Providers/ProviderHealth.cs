using System.Collections.Concurrent;
using System.Text.RegularExpressions;

namespace Vystral.Core.Providers;

/// <summary>Whether a provider may be used right now, and why not in plain words ("Off", "Needs your key", "Offline mode").</summary>
public sealed record ProviderAvailability(bool Enabled, bool OptIn, string? Why)
{
    public static ProviderAvailability On(bool optIn = false) => new(true, optIn, null);
    public static ProviderAvailability Off(string why, bool optIn = true) => new(false, optIn, why);
}

/// <summary>
/// What a provider is: a stable id ("steam.store", "igdb"), the name people know, a group for the page, the
/// <c>ServiceLogo</c> mark id (or null for a plain icon) and what VYSTRAL uses it for.
/// </summary>
public sealed record ProviderDescriptor(string Id, string Name, string Group, string? Logo, string Purpose);

/// <summary>One provider at a glance, as the Data sources health page shows it.</summary>
public sealed record ProviderHealthEntry(
    string Id, string Name, string Group, string? Logo, string Purpose,
    bool Enabled, bool OptIn, string? DisabledReason,
    string State, // "ok" | "error" | "backoff" | "idle" | "off"
    DateTimeOffset? LastSuccess, DateTimeOffset? LastError, string? LastErrorText,
    DateTimeOffset? BackoffUntil, string? BackoffReason,
    int RequestsToday, DateTimeOffset? CacheUpdated);

/// <summary>Counters a registry can save and restore, so "requests today" survives a restart.</summary>
public sealed record ProviderCounters(string Id, string Day, int RequestsToday, DateTimeOffset? LastSuccess, DateTimeOffset? LastError, string? LastErrorText);

/// <summary>
/// Track D6: the shared health registry every outbound provider reports through. A client calls <see cref="Request"/>
/// as it sends, then <see cref="Success"/> or <see cref="Failure"/>, and <see cref="BackOff"/> when it pauses itself
/// (429, Retry-After, 5xx). The registry never sends anything itself and never sees URLs, keys or bodies: only the
/// provider id, times and a short plain-words reason (cleaned and clipped here, because it reaches the page).
/// <para>
/// To add a provider (for example a new Track D4 client): call <see cref="Register"/> once at start-up with an id, a
/// descriptor, an availability callback (settings, opt-in, key present, Offline mode) and, if it caches, a callback for
/// the cache's last update; then report from the client. Reports for an id nobody registered are kept too (so a
/// client can't crash by reporting early) and appear once it is registered. Registering the same id again replaces
/// the descriptor and callbacks and keeps the counters.
/// </para>
/// </summary>
public sealed partial class ProviderHealthRegistry
{
    public const int MaxReasonLength = 160;
    public const int MaxProviders = 64;

    private sealed class Slot
    {
        public ProviderDescriptor? Descriptor;
        public Func<ProviderAvailability>? Availability;
        public Func<DateTimeOffset?>? CacheUpdated;
        public string Day = "";
        public int Requests;
        public DateTimeOffset? LastSuccess, LastError, BackoffUntil;
        public string? LastErrorText, BackoffReason;
        public int Order;
    }

    private readonly ConcurrentDictionary<string, Slot> _slots = new(StringComparer.Ordinal);
    private int _order;
    private int _version;

    public Func<DateTimeOffset> Clock { get; set; } = () => DateTimeOffset.Now;
    /// <summary>"Today" is the user's local day.</summary>
    public TimeZoneInfo TimeZone { get; set; } = TimeZoneInfo.Local;

    /// <summary>Bumped on every report, so a store can save only when something changed.</summary>
    public int Version => Volatile.Read(ref _version);

    [GeneratedRegex(@"^[a-z0-9][a-z0-9.\-]{0,47}\z")]
    private static partial Regex IdRx();

    public static bool IsId(string? id) => id is not null && IdRx().IsMatch(id);

    public void Register(ProviderDescriptor descriptor, Func<ProviderAvailability>? availability = null, Func<DateTimeOffset?>? cacheUpdated = null)
    {
        ArgumentNullException.ThrowIfNull(descriptor);
        if (!IsId(descriptor.Id)) throw new ArgumentException("Provider ids are lower-case letters, digits, dots and dashes.", nameof(descriptor));
        var slot = SlotFor(descriptor.Id);
        if (slot is null) return;
        lock (slot)
        {
            if (slot.Descriptor is null) slot.Order = Interlocked.Increment(ref _order);
            slot.Descriptor = descriptor;
            slot.Availability = availability;
            slot.CacheUpdated = cacheUpdated;
        }
        Interlocked.Increment(ref _version);
    }

    public bool IsRegistered(string id) => _slots.TryGetValue(id, out var s) && s.Descriptor is not null;

    /// <summary>A request is about to be sent.</summary>
    public void Request(string id)
    {
        if (SlotFor(id) is not { } s) return;
        lock (s)
        {
            Roll(s);
            s.Requests++;
        }
        Interlocked.Increment(ref _version);
    }

    /// <summary>An answer was received and used. Ends any back-off.</summary>
    public void Success(string id)
    {
        if (SlotFor(id) is not { } s) return;
        lock (s)
        {
            s.LastSuccess = Clock();
            if (s.BackoffUntil is { } u && u <= s.LastSuccess) { s.BackoffUntil = null; s.BackoffReason = null; }
        }
        Interlocked.Increment(ref _version);
    }

    /// <summary>A request failed; <paramref name="reason"/> is shown as-is, so use plain words ("Timed out", "The key was refused").</summary>
    public void Failure(string id, string reason)
    {
        if (SlotFor(id) is not { } s) return;
        lock (s)
        {
            s.LastError = Clock();
            s.LastErrorText = Clean(reason) ?? "Something went wrong";
        }
        Interlocked.Increment(ref _version);
    }

    /// <summary>The client is pausing itself until <paramref name="until"/> (rate limit or server trouble).</summary>
    public void BackOff(string id, DateTimeOffset until, string reason)
    {
        if (SlotFor(id) is not { } s) return;
        lock (s)
        {
            s.BackoffUntil = until;
            s.BackoffReason = Clean(reason) ?? "Asked to slow down";
        }
        Interlocked.Increment(ref _version);
    }

    /// <summary>Everything registered, in registration order.</summary>
    public IReadOnlyList<ProviderHealthEntry> Snapshot()
    {
        var now = Clock();
        var list = new List<(int Order, ProviderHealthEntry Entry)>();
        foreach (var (_, s) in _slots)
        {
            ProviderDescriptor d;
            Func<ProviderAvailability>? availability;
            Func<DateTimeOffset?>? cache;
            int requests, order;
            DateTimeOffset? ok, err, backoff;
            string? errText, backoffWhy;
            lock (s)
            {
                if (s.Descriptor is null) continue;
                Roll(s);
                d = s.Descriptor; availability = s.Availability; cache = s.CacheUpdated; order = s.Order;
                requests = s.Requests; ok = s.LastSuccess; err = s.LastError; errText = s.LastErrorText;
                backoff = s.BackoffUntil is { } u && u > now ? u : null;
                backoffWhy = backoff is null ? null : s.BackoffReason;
            }
            var a = Safe(availability) ?? ProviderAvailability.On();
            DateTimeOffset? cached = null;
            try { cached = cache?.Invoke(); } catch (Exception ex) when (ex is IOException or UnauthorizedAccessException or InvalidOperationException) { }
            var state = !a.Enabled ? "off"
                : backoff is not null ? "backoff"
                : err is not null && (ok is null || err > ok) ? "error"
                : ok is not null ? "ok"
                : "idle";
            list.Add((order, new ProviderHealthEntry(d.Id, d.Name, d.Group, d.Logo, d.Purpose, a.Enabled, a.OptIn, a.Enabled ? null : Clean(a.Why),
                state, ok, err, err is null ? null : errText, backoff, backoffWhy, requests, cached)));
        }
        return list.OrderBy(x => x.Order).Select(x => x.Entry).ToList();
    }

    /// <summary>The counters to save (only providers that have done something).</summary>
    public IReadOnlyList<ProviderCounters> Export()
    {
        var list = new List<ProviderCounters>();
        foreach (var (id, s) in _slots)
            lock (s)
            {
                Roll(s);
                if (s.Requests == 0 && s.LastSuccess is null && s.LastError is null) continue;
                list.Add(new ProviderCounters(id, s.Day, s.Requests, s.LastSuccess, s.LastError, s.LastErrorText));
            }
        return list;
    }

    /// <summary>Restores saved counters (validated: unknown shapes are skipped, a past day's count is dropped).</summary>
    public void Import(IEnumerable<ProviderCounters>? saved)
    {
        if (saved is null) return;
        var now = Clock();
        foreach (var c in saved.Take(MaxProviders))
        {
            if (c is null || !IsId(c.Id) || SlotFor(c.Id) is not { } s) continue;
            lock (s)
            {
                Roll(s);
                if (c.Day == s.Day && c.RequestsToday is > 0 and < 1_000_000) s.Requests = Math.Max(s.Requests, c.RequestsToday);
                if (c.LastSuccess is { } ok && ok <= now && (s.LastSuccess is null || ok > s.LastSuccess)) s.LastSuccess = ok;
                if (c.LastError is { } er && er <= now && (s.LastError is null || er > s.LastError)) { s.LastError = er; s.LastErrorText = Clean(c.LastErrorText) ?? "Something went wrong"; }
            }
        }
    }

    private Slot? SlotFor(string id)
    {
        if (!IsId(id)) return null;
        if (_slots.TryGetValue(id, out var s)) return s;
        if (_slots.Count >= MaxProviders) return null;
        return _slots.GetOrAdd(id, _ => new Slot { Day = Today() });
    }

    private void Roll(Slot s)
    {
        var today = Today();
        if (s.Day == today) return;
        s.Day = today;
        s.Requests = 0;
    }

    private string Today() => TimeZoneInfo.ConvertTime(Clock(), TimeZone).ToString("yyyy-MM-dd", System.Globalization.CultureInfo.InvariantCulture);

    private static ProviderAvailability? Safe(Func<ProviderAvailability>? f)
    {
        try { return f?.Invoke(); }
        catch (Exception ex) when (ex is InvalidOperationException or IOException or ObjectDisposedException) { return null; }
    }

    /// <summary>Control and bidi characters removed, whitespace collapsed, clipped.</summary>
    public static string? Clean(string? text)
    {
        if (string.IsNullOrWhiteSpace(text)) return null;
        var sb = new System.Text.StringBuilder(Math.Min(text.Length, MaxReasonLength + 1));
        var space = false;
        foreach (var ch in text)
        {
            if (sb.Length >= MaxReasonLength) break;
            var cat = char.GetUnicodeCategory(ch);
            if (char.IsWhiteSpace(ch) || cat is System.Globalization.UnicodeCategory.Control) { space = sb.Length > 0; continue; }
            if (cat is System.Globalization.UnicodeCategory.Format or System.Globalization.UnicodeCategory.Surrogate or System.Globalization.UnicodeCategory.PrivateUse) continue;
            if (space) { sb.Append(' '); space = false; }
            sb.Append(ch);
        }
        var s = sb.ToString().Trim();
        if (s.Length == 0) return null;
        return s.Length >= MaxReasonLength ? s[..(MaxReasonLength - 1)].TrimEnd() + "…" : s;
    }
}
