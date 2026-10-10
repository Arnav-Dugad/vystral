using System.Text.Json.Nodes;
using Vystral.Core.Contracts;

namespace Vystral.Windows.Ai.Assistant;

/// <summary>
/// An action the assistant proposes. It is never run natively: the page shows it as a card with the exact change, and only
/// the user's click runs it, through the same bridge calls the rest of the app uses. <c>Args</c> are already validated.
/// </summary>
public sealed record AssistantProposal(string Id, string Tool, string Title, string Detail, string Confirm, JsonObject Args);

/// <summary>Track D3: turns a validated action call into a proposal, checking that everything it names exists.</summary>
public static class AssistantActions
{
    private static readonly Dictionary<string, string> PageNames = new(StringComparer.Ordinal)
    {
        ["home"] = "Home", ["library"] = "Library", ["journal"] = "Journal", ["performance"] = "Performance", ["moments"] = "Moments",
        ["constellation"] = "Constellation", ["storage"] = "Storage", ["health"] = "Library health", ["discover"] = "Discover",
        ["wishlist"] = "Wishlist", ["settings"] = "Settings",
    };

    private static readonly Dictionary<string, string> StatusNames = new(StringComparer.Ordinal)
    {
        ["backlog"] = "Backlog", ["playing"] = "Playing", ["beaten"] = "Beaten", ["completed"] = "Completed", ["abandoned"] = "Abandoned", ["none"] = "no status",
    };

    /// <summary>Returns the proposal, or a reason for the model when the call names something that doesn't exist.</summary>
    public static (AssistantProposal? Proposal, string? Error) Propose(ToolSpec spec, JsonObject args, LibrarySnapshotDto snapshot, string id)
    {
        if (spec.Kind != ToolKind.Action) return (null, "That isn’t an action.");
        GameDto? Game(string? gid) => gid is null ? null : snapshot.Games.FirstOrDefault(g => g.Id == gid && !g.Hidden);
        var gameId = AiText.Str(args["gameId"]);
        switch (spec.Name)
        {
            case "open_page":
            {
                var page = AiText.Str(args["page"])!;
                return (new(id, spec.Name, $"Open {PageNames[page]}", "Goes to that page in VYSTRAL.", "Open", args), null);
            }
            case "open_game":
            {
                var g = Game(gameId);
                if (g is null) return (null, "No game with that id is in the library.");
                return (new(id, spec.Name, $"Open {g.Title}", "Shows the game’s page. Nothing is launched.", "Open page", With(args, "title", g.Title)), null);
            }
            case "set_favorite":
            {
                var g = Game(gameId);
                if (g is null) return (null, "No game with that id is in the library.");
                var fav = AiText.Bool(args["favorite"]) ?? true;
                if (g.Favorite == fav) return (null, $"{g.Title} is already {(fav ? "a favorite" : "not a favorite")}. Tell the user; nothing needs to change.");
                return (new(id, spec.Name, fav ? $"Add {g.Title} to favorites" : $"Remove {g.Title} from favorites",
                    "You can change it back at any time.", fav ? "Add to favorites" : "Remove", With(args, "title", g.Title)), null);
            }
            case "set_status":
            {
                var g = Game(gameId);
                if (g is null) return (null, "No game with that id is in the library.");
                var status = AiText.Str(args["status"])!;
                if ((g.Status ?? "none") == status) return (null, $"{g.Title} already has that status. Tell the user; nothing needs to change.");
                var from = StatusNames[g.Status ?? "none"];
                return (new(id, spec.Name, status == "none" ? $"Clear {g.Title}’s status" : $"Mark {g.Title} as {StatusNames[status]}",
                    $"Currently: {from}. You can change it back at any time.", status == "none" ? "Clear status" : "Set status", With(args, "title", g.Title)), null);
            }
            case "create_collection":
            {
                var name = AiText.Clean(AiText.Str(args["name"]), 60);
                if (name.Length == 0) return (null, "The collection needs a name.");
                var ids = (args["gameIds"] as JsonArray ?? []).Select(AiText.Str).OfType<string>().ToList();
                var games = ids.Select(Game).ToList();
                if (ids.Count == 0) return (null, "Add at least one game id.");
                if (games.Any(g => g is null)) return (null, "Some of those ids aren’t games in the library. Use ids from search_library.");
                var titles = games.Select(g => g!.Title).ToList();
                var shown = string.Join(", ", titles.Take(4)) + (titles.Count > 4 ? $" and {titles.Count - 4} more" : "");
                var a = new JsonObject { ["name"] = name, ["gameIds"] = args["gameIds"]!.DeepClone(), ["titles"] = new JsonArray(titles.Select(t => (JsonNode)JsonValue.Create(t)!).ToArray()) };
                return (new(id, spec.Name, $"Create “{name}”", $"A collection with {titles.Count} {(titles.Count == 1 ? "game" : "games")}: {shown}.", "Create collection", a), null);
            }
            case "create_smart_collection":
            {
                var name = AiText.Clean(AiText.Str(args["name"]), 60);
                if (name.Length == 0) return (null, "The collection needs a name.");
                var known = snapshot.Games.SelectMany(g => g.Genres).Distinct(StringComparer.OrdinalIgnoreCase).ToList();
                var filter = SmartFilterSpec.Validate(args["filter"] as JsonObject, known, out var dropped);
                if (filter is null) return (null, "That filter isn’t valid, or uses no criteria. Use genres from the library.");
                var a = new JsonObject { ["name"] = name, ["filter"] = filter };
                var detail = "A saved filter that keeps itself up to date." + (dropped.Count > 0 ? $" Left out (not in your library): {string.Join(", ", dropped.Take(4))}." : "");
                return (new(id, spec.Name, $"Create smart collection “{name}”", detail, "Create collection", a), null);
            }
            case "start_discover_search":
            {
                var q = AiText.Clean(AiText.Str(args["query"]), 100);
                if (q.Length < 2) return (null, "Search for at least two letters.");
                return (new(id, spec.Name, $"Search Discover for “{q}”", "Opens Discover with these results.", "Search", new JsonObject { ["query"] = q }), null);
            }
            case "watch_game":
            {
                var title = AiText.Clean(AiText.Str(args["title"]), 120);
                return (new(id, spec.Name, $"Watch {title}", "Adds it to your Watching list for price and release alerts. You can remove it any time.", "Add to Watching",
                    new JsonObject { ["key"] = AiText.Str(args["key"]), ["title"] = title }), null);
            }
            default:
                return (null, "Unknown action.");
        }
    }

    private static JsonObject With(JsonObject o, string key, string value)
    {
        var c = o.DeepClone().AsObject();
        c[key] = value;
        return c;
    }
}
