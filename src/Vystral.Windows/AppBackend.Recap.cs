using System.Globalization;
using System.Text.Json;
using Vystral.Core.Data;
using Vystral.Core.Domain;
using Vystral.Windows.Bridge;
using Vystral.Windows.DataSources;
using Vystral.Windows.Launch;
using Vystral.Windows.Recap;
using Vystral.Windows.Services;
using static Vystral.Windows.Bridge.BridgeDispatcher;

namespace Vystral.Windows;

// Track M parameter records.
public sealed record AwaySeenParams(string Until);
public sealed record ReplayBeginParams(string SessionId, int Bytes);
public sealed record ReplayChunkParams(string Token, int Index, string Data);
public sealed record ReplayTokenParams(string Token);

/// <summary>Session replay card data: the session, its recap numbers and the achievements unlocked during it.</summary>
public sealed record ReplayDto(AwaySessionDto Session, IReadOnlyList<RecapAchievementDto> Achievements, bool SteamGame, bool AchievementsKnown);

/// <summary>
/// Track M (v0.5): the "while you were away" card, time-to-beat bars, anti-cheat notes, the library value
/// forecast (next Steam sale, backlog savings estimate) and session replay cards (Save as image / Copy image).
/// Everything is read from data already on this PC; nothing here contacts the network.
/// </summary>
public sealed partial class AppBackend
{
    public const string AwaySeenKey = "home.awayLastSeen";
    public const string AntiCheatNotesSetting = "launch.antiCheatNotes";
    public const string TimeToBeatSetting = "library.timeToBeat";

    private readonly ReplayImageStore _replayImages = new();

    /// <summary>The shell's clipboard (set by the WinUI host); null in tests.</summary>
    public IClipboardHost? ClipboardHost { get; set; }

    private void RegisterRecapHandlers()
    {
        // ---- While you were away ----
        Dispatcher.Register("away.summary", _ => Task.FromResult<object?>(AwayNow()));
        Dispatcher.Register<AwaySeenParams>("away.markSeen", (p, _) =>
        {
            if (!DateTimeOffset.TryParse(RequireText(p.Until, 40, "Time"), CultureInfo.InvariantCulture, DateTimeStyles.AssumeUniversal, out var until))
                throw new BridgeException("invalid", "Invalid time.");
            MarkAwaySeen(until, DateTimeOffset.UtcNow);
            return Task.FromResult<object?>(true);
        });

        // ---- Time to beat ----
        Dispatcher.Register("ttb.map", _ => Task.FromResult<object?>(TimeToBeatMap()));

        // ---- Library value forecast ----
        Dispatcher.Register("forecast.sales", _ => Task.FromResult<object?>(SaleCalendar.Forecast(SaleCalendar.Shipped, DateOnly.FromDateTime(DateTime.Now))));
        Dispatcher.Register("forecast.openSource", _ =>
        {
            // The URL comes from the shipped, validated calendar (https on a Valve domain), never from the page.
            _shell.OpenUri(new Uri(SaleCalendar.Shipped.SourceUrl));
            return Task.FromResult<object?>(true);
        });
        Dispatcher.Register("forecast.backlogSavings", _ => Task.FromResult<object?>(BacklogSavingsNow()));

        // ---- Anti-cheat note for the game page (the pre-flight row is built in BuildPreflightChecks) ----
        Dispatcher.Register<GameIdParams>("compat.antiCheatNote", (p, _) => Task.FromResult<object?>(AntiCheatNoteFor(RequireId(p.GameId, "game"))));

        // ---- Session replay ----
        Dispatcher.Register<SessionIdParams>("replay.get", (p, _) =>
        {
            var row = Repository.GetRecapSession(RequireId(p.SessionId, "session")) ?? throw new BridgeException("notFound", "That session is no longer in your journal.");
            return Task.FromResult<object?>(Replay(row));
        });
        Dispatcher.Register<ReplayBeginParams>("replay.imageBegin", (p, _) =>
        {
            var sessionId = RequireId(p.SessionId, "session");
            if (Repository.GetRecapSession(sessionId) is null) throw new BridgeException("notFound", "That session is no longer in your journal.");
            return Task.FromResult<object?>(new { token = _replayImages.Begin(sessionId, p.Bytes), maxChunk = ReplayImageStore.MaxChunkChars });
        });
        Dispatcher.Register<ReplayChunkParams>("replay.imageChunk", (p, _) =>
            Task.FromResult<object?>(new { received = _replayImages.Append(RequireToken(p.Token), p.Index, p.Data ?? "") }));
        Dispatcher.Register<ReplayTokenParams>("replay.imageSave", async (p, _) =>
        {
            var (sessionId, png) = _replayImages.Take(RequireToken(p.Token));
            var row = Repository.GetRecapSession(sessionId) ?? throw new BridgeException("notFound", "That session is no longer in your journal.");
            var path = await _shell.PickSaveFileAsync(ReplayImageStore.SuggestedName(row.Title, row.Start), ".png", "PNG image");
            if (path is null) return null;
            if (!path.EndsWith(".png", StringComparison.OrdinalIgnoreCase)) path += ".png";
            var tmp = path + ".tmp";
            await File.WriteAllBytesAsync(tmp, png);
            File.Move(tmp, path, overwrite: true);
            Repository.Audit("replay.saveImage", sessionId);
            return new { path };
        });
        Dispatcher.Register<ReplayTokenParams>("replay.imageCopy", async (p, _) =>
        {
            var (_, png) = _replayImages.Take(RequireToken(p.Token));
            var host = ClipboardHost ?? throw new BridgeException("unsupported", "The clipboard isn't available right now.");
            if (!await host.CopyPngAsync(png)) throw new BridgeException("unavailable", "The clipboard is busy. Try again in a moment.");
            return true;
        });
    }

    private static string RequireToken(string? token) =>
        token is { Length: 32 } && token.All(char.IsAsciiHexDigitLower) ? token : throw new BridgeException("invalid", "Invalid upload.");

    // ---------------- away ----------------

    /// <summary>
    /// The away summary since Home was last opened. On the very first call there is no marker yet: one is set
    /// to now and nothing is shown, so a new install never surfaces old history as "while you were away".
    /// </summary>
    private object AwayNow()
    {
        var now = DateTimeOffset.UtcNow;
        var since = AwaySummary.ParseSeen(Repository.GetInternalValue(AwaySeenKey), now);
        if (since is null)
        {
            Repository.SetInternalValue(AwaySeenKey, now.ToString("O"));
            return new { summary = (AwaySummaryDto?)null, firstVisit = true };
        }
        var rows = Repository.ObservedSessionsEndedAfter(since.Value, AwaySummary.Sources, 200);
        var summary = AwaySummary.Build(rows, since.Value, now, UnlocksDuring, appId => Repository.AchievementsFetched(appId));
        return new { summary, firstVisit = false };
    }

    /// <summary>Moves the marker forward only (never back, never past now).</summary>
    private void MarkAwaySeen(DateTimeOffset until, DateTimeOffset now)
    {
        if (until > now) until = now;
        var current = AwaySummary.ParseSeen(Repository.GetInternalValue(AwaySeenKey), now);
        if (current is null || until > current) Repository.SetInternalValue(AwaySeenKey, until.ToString("O"));
    }

    private IReadOnlyList<RecapAchievementDto> UnlocksDuring(RecapSessionRow s) =>
        s.SteamAppId is not { } appId ? [] :
            Repository.UnlocksBetween(appId, s.Start, s.End + AwaySummary.UnlockSlack)
                .Select(u => new RecapAchievementDto(s.GameId, s.Id, u.ApiName, u.DisplayName, u.Description, u.UnlockedAt.ToString("O"), u.GlobalPercent,
                    IconUrl(u.IconFile ?? u.IconGrayFile)))
                .ToList();

    // ---------------- time to beat ----------------

    private TimeToBeatMapDto TimeToBeatMap()
    {
        if (!Settings.GetBool(TimeToBeatSetting)) return new TimeToBeatMapDto(new Dictionary<string, TimeToBeatDto>(), "disabled");
        if (!_dataSources.IsConfigured(KeyedProvider.Igdb)) return new TimeToBeatMapDto(new Dictionary<string, TimeToBeatDto>(), "noKey");
        var map = TimeToBeatData.Map(Repository.IgdbTimeToBeatRows());
        return new TimeToBeatMapDto(map, map.Count == 0 ? "noData" : null);
    }

    // ---------------- forecast ----------------

    private BacklogSavingsDto BacklogSavingsNow()
    {
        var country = _dataSources.Country;
        var useCheapShark = Settings.GetBool("dataSources.cheapshark");
        var useItad = _dataSources.IsConfigured(KeyedProvider.IsThereAnyDeal);
        var candidates = Repository.BacklogCandidates();
        IReadOnlyList<CachedQuote> QuotesFor(string appId)
        {
            var list = new List<CachedQuote>(2);
            if (useItad && Repository.GetProviderCache("deals-itad", $"{appId}:{country}") is { } i && ParseQuote(i.Body) is { } iq)
                list.Add(new CachedQuote("itad", iq, i.Fetched, !i.Fresh));
            if (useCheapShark && Repository.GetProviderCache("deals-cheapshark", appId) is { } c && ParseQuote(c.Body) is { } cq)
                list.Add(new CachedQuote("cheapshark", cq, c.Fetched, !c.Fresh));
            return list;
        }
        var reason = !useCheapShark && !useItad ? "disabled" : candidates.Count == 0 ? "noBacklog" : null;
        var result = BacklogSavings.Build(candidates, QuotesFor, country, reason);
        return result.Games.Count == 0 && result.Reason is null ? result with { Reason = "noPrices" } : result;
    }

    private static PriceQuote? ParseQuote(string body)
    {
        try
        {
            var q = JsonSerializer.Deserialize<PriceQuote?>(body, EnrichmentService.Json);
            return q is { Currency.Length: 3, Offers: not null } ? q : null;
        }
        catch (JsonException) { return null; }
    }

    // ---------------- anti-cheat ----------------

    private AntiCheatRow? AntiCheatRowFor(string gameId) =>
        Settings.GetBool("dataSources.antiCheat") && Repository.GetGame(gameId)?.SteamAppId is { } appId ? Repository.GetAntiCheat("steam", appId) : null;

    private AntiCheatNoteDto? AntiCheatNoteFor(string gameId) =>
        Settings.GetBool(AntiCheatNotesSetting) ? AntiCheatNotes.For(AntiCheatRowFor(gameId), Settings.GetBool("fps.captureEnabled")) : null;

    /// <summary>The pre-flight row (added in BuildPreflightChecks). Local data only, so it fits the 300 ms budget.</summary>
    private PreflightCheckDto? AntiCheatPreflight(Installation inst) =>
        Settings.GetBool(AntiCheatNotesSetting) ? AntiCheatNotes.Preflight(AntiCheatRowFor(inst.GameId), Settings.GetBool("fps.captureEnabled")) : null;

    // ---------------- replay ----------------

    private ReplayDto Replay(RecapSessionRow row)
    {
        var steam = row.SteamAppId is not null;
        return new ReplayDto(AwaySummary.ToDto(row), UnlocksDuring(row), steam, steam && Repository.AchievementsFetched(row.SteamAppId!));
    }
}
