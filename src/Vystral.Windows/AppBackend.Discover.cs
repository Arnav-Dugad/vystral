using Vystral.Windows.Bridge;
using Vystral.Windows.Discover;
using static Vystral.Windows.Bridge.BridgeDispatcher;

namespace Vystral.Windows;

// Track U parameter records.
public sealed record DiscoverSearchParams(string Query, string? Channel, int? Page);
public sealed record DiscoverChannelParams(string Channel);
public sealed record DiscoverKeyParams(string Key, bool? Refresh);
public sealed record DiscoverImageParams(string Key, string Kind);
public sealed record DiscoverLinkParams(string Key, string Link);
public sealed record DiscoverOfferParams(string Key, string OfferId);
public sealed record DiscoverWatchParams(string Key, bool On);

/// <summary>
/// Track U: universal game search (Steam store search, IGDB, RAWG, Wikidata) and pages for games that aren't in the
/// library. The page sends only what was typed and opaque keys (validated against strict shapes); every URL is built or
/// looked up natively, and nothing is ever launched or installed: store pages open in the browser.
/// </summary>
public sealed partial class AppBackend
{
    private DiscoverService? _discover;
    public DiscoverService Discover => _discover ?? throw new InvalidOperationException("Discover is not initialised yet.");

    private static readonly HashSet<string> DiscoverImageKinds = new(StringComparer.Ordinal) { "cover", "hero", "logo", "header" };
    private static readonly HashSet<string> DiscoverLinkIds = new(StringComparer.Ordinal) { "steam", "gog", "epic", "microsoft", "igdb", "rawg", "wikidata" };

    private void RegisterDiscoverHandlers()
    {
        _discover = new DiscoverService(Repository, Settings, Artwork, _dataSources, () => _cloud, () => _trailers, _events, Paths.Root, () => DataSaverActive);

        Settings.Changed += key =>
        {
            if (key is DiscoverService.SearchSetting or "privacy.localOnly" or "library.fetchMetadata" or "dataSources.wikidata" or "dataSaver.enabled" or "*")
                _events.Emit("discover.changed", _discover.Status());
        };

        Dispatcher.Register("discover.status", _ => Task.FromResult<object?>(_discover.Status()));
        Dispatcher.Register<DiscoverSearchParams>("discover.search", (p, _) =>
        {
            var channel = RequireDiscoverChannel(p.Channel ?? "page");
            var query = DiscoverService.CleanQuery(RequireText(p.Query, 200, "Search")) ?? throw new BridgeException("invalid", "Type at least two letters to search.");
            return Task.FromResult<object?>(_discover.Search(query, channel, Math.Clamp(p.Page ?? 0, 0, DiscoverService.MaxPages - 1)));
        });
        Dispatcher.Register<DiscoverChannelParams>("discover.cancel", (p, _) =>
        {
            _discover.Cancel(RequireDiscoverChannel(p.Channel));
            return Task.FromResult<object?>(true);
        });
        Dispatcher.Register<DiscoverKeyParams>("discover.details", async (p, ct) => await _discover.DetailsAsync(RequireDiscoverKey(p.Key), p.Refresh ?? false, ct));
        Dispatcher.Register<DiscoverImageParams>("discover.image", async (p, ct) =>
        {
            var key = RequireDiscoverKey(p.Key);
            var kind = p.Kind is not null && DiscoverImageKinds.Contains(p.Kind) ? p.Kind : throw new BridgeException("invalid", "Unknown image kind.");
            var (url, reason) = await _discover.ImageAsync(key, kind, ct);
            return new { url, reason };
        });
        Dispatcher.Register<DiscoverLinkParams>("discover.openLink", (p, _) =>
        {
            var key = RequireDiscoverKey(p.Key);
            var link = p.Link is not null && DiscoverLinkIds.Contains(p.Link) ? p.Link : throw new BridgeException("invalid", "Unknown link.");
            var url = _discover.LinkUrl(key, link) ?? throw new BridgeException("notFound", "There’s no page for this game on that site.");
            _shell.OpenUri(new Uri(url));
            return Task.FromResult<object?>(true);
        });
        Dispatcher.Register<DiscoverKeyParams>("discover.deals", async (p, ct) => await Run(() => _discover.DealsAsync(RequireDiscoverKey(p.Key), p.Refresh ?? false, ct)));
        Dispatcher.Register<DiscoverOfferParams>("discover.openOffer", (p, _) =>
        {
            var url = _discover.OfferUrl(RequireDiscoverKey(p.Key), RequireOption(p.OfferId)) ?? throw new BridgeException("notFound", "That deal is no longer listed. Refresh the prices.");
            _shell.OpenUri(new Uri(url));
            return Task.FromResult<object?>(true);
        });
        Dispatcher.Register("discover.watching", _ => Task.FromResult<object?>(_discover.Watching()));
        Dispatcher.Register<DiscoverWatchParams>("discover.watch", (p, _) =>
        {
            var key = RequireDiscoverKey(p.Key);
            try
            {
                var list = _discover.SetWatching(key, p.On);
                _events.Emit("discover.watching", list);
                return Task.FromResult<object?>(list);
            }
            catch (Exception ex) when (ex is IOException or UnauthorizedAccessException)
            {
                throw new BridgeException("unavailable", "VYSTRAL couldn’t save your Watching list. Check that the data folder isn’t read-only.");
            }
        });
    }

    private static string RequireDiscoverKey(string? key) =>
        DiscoverKeys.IsKey(key) ? key! : throw new BridgeException("invalid", "Unknown game.");

    private static string RequireDiscoverChannel(string? channel) =>
        channel is "bar" or "page" ? channel : throw new BridgeException("invalid", "Unknown search.");
}
