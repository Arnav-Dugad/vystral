using System.Net;
using Vystral.Core.Providers;
using Vystral.Windows.Services.NetworkHealth;

namespace Vystral.Windows.Services;

/// <summary>
/// Track D6: the process-wide <see cref="ProviderHealthRegistry"/> and the plain-words helpers clients use to report to
/// it. The shared lanes (<c>ProviderTransport</c>, <c>SteamWebApiClient</c>) report automatically; a client with its
/// own HttpClient calls <see cref="Sent"/> and <see cref="Answered"/> / <see cref="Failed"/> around each request.
/// Reports are cheap (a lock and two fields) and never throw.
/// <para>
/// New provider checklist (e.g. Track D4): (1) pick an id (lower case, dots and dashes, e.g. "opencritic"); (2) if it
/// goes through <c>ProviderTransport</c>, name the lane with that id (or add a mapping in <see cref="IdForLane"/>) and
/// it reports by itself; otherwise call <see cref="Sent"/>/<see cref="Answered"/>/<see cref="Failed"/>; (3) register
/// its descriptor in <c>AppBackend.TrackD6.cs</c> (<c>RegisterProviderHealth</c>) with an availability callback (its
/// setting, key, Offline mode) and, if it caches, the cache's last update; (4) add its mark to <c>serviceMarks.ts</c>.
/// </para>
/// </summary>
public static class ProviderHealthHub
{
    public static ProviderHealthRegistry Registry { get; set; } = new();

    /// <summary>Lane names (as built by the data-source, cloud, subscription and AI services) → health rows.</summary>
    public static string IdForLane(string lane) => lane switch
    {
        "steamdeck" => "steam.store",
        "workshop" => "steam.store",
        "cloud.gfn" => "gfn.catalog",
        "cloud.gfnStatus" => "gfn.status",
        "cloud.xbox" or "subs.gamepass" => "gamepass.catalog",
        "cloud.msstore" or "subs.msstore" => "msstore",
        _ => lane.ToLowerInvariant(),
    };

    public static void Sent(string id) => Registry.Request(id);

    public static void Answered(string id) => Registry.Success(id);

    public static void Failed(string id, string reason) => Registry.Failure(id, reason);

    public static void Failed(string id, Exception ex) => Registry.Failure(id, NetworkErrors.Describe(ex).Text);

    public static void PausedUntil(string id, DateTimeOffset until, string reason) => Registry.BackOff(id, until, reason);

    /// <summary>A status code that reached a client: what it means for the provider's health.</summary>
    public static void Status(string id, HttpStatusCode status, string displayName)
    {
        var code = (int)status;
        if (code is >= 200 and < 400 or 404) { Answered(id); return; }
        Failed(id, code switch
        {
            401 => $"{displayName} didn’t accept the key (HTTP 401)",
            403 => $"{displayName} refused the request (HTTP 403) — usually too many requests or a key problem",
            >= 500 => $"{displayName} had a problem on its side (HTTP {code})",
            _ => $"{displayName} sent an unexpected answer (HTTP {code})",
        });
    }
}
