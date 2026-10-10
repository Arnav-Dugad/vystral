using System.Text.Json;
using System.Text.Json.Nodes;
using System.Text.RegularExpressions;
using Vystral.Windows.Services;

namespace Vystral.Windows.Ai.Assistant;

public sealed record AsstConversationInfo(string Id, string Title, string UpdatedAt, int Messages);

/// <summary>
/// Track D3: saved Assistant conversations, one small JSON file each under the data folder (<c>assistant\</c>), so they
/// stay on this PC and go away with "Delete all conversations" or the folder. The page owns the conversation's shape;
/// this store only checks the id, title, size and nesting, keeps at most <see cref="MaxConversations"/> (oldest go first)
/// and re-reads files defensively (anything malformed reads as missing).
/// </summary>
public sealed partial class AssistantHistory(string folder)
{
    public const int MaxConversations = 50;
    public const int MaxChars = 400_000;
    private readonly Lock _lock = new();

    public static bool IsId(string? id) => id is not null && IdPattern().IsMatch(id);

    private string FileFor(string id) => Path.Combine(folder, $"{id}.json");

    public IReadOnlyList<AsstConversationInfo> List()
    {
        lock (_lock)
        {
            if (!Directory.Exists(folder)) return [];
            var list = new List<AsstConversationInfo>();
            foreach (var path in Directory.EnumerateFiles(folder, "*.json").Take(MaxConversations * 2))
            {
                var id = Path.GetFileNameWithoutExtension(path);
                if (!IsId(id) || Read(id) is not { } o) continue;
                list.Add(new AsstConversationInfo(id, AiText.Clean(AiText.Str(o["title"]), 120), AiText.Str(o["updatedAt"]) ?? "",
                    (o["messages"] as JsonArray)?.Count ?? 0));
            }
            return list.OrderByDescending(c => c.UpdatedAt, StringComparer.Ordinal).ToList();
        }
    }

    public JsonObject? Get(string id)
    {
        if (!IsId(id)) return null;
        lock (_lock) return Read(id);
    }

    /// <summary>Saves a conversation. Returns an error message when it isn't acceptable.</summary>
    public string? Save(string id, JsonElement conversation)
    {
        if (!IsId(id)) return "Invalid conversation.";
        if (conversation.ValueKind != JsonValueKind.Object) return "Invalid conversation.";
        var raw = conversation.GetRawText();
        if (raw.Length > MaxChars) return "That conversation is too long to keep. Start a new one.";
        JsonObject o;
        try { o = JsonNode.Parse(raw, documentOptions: new JsonDocumentOptions { MaxDepth = 24 }) as JsonObject ?? throw new JsonException(); }
        catch (JsonException) { return "Invalid conversation."; }
        if (o["messages"] is not JsonArray { Count: <= 200 }) return "Invalid conversation.";
        o["id"] = id;
        o["title"] = AiText.Clean(AiText.Str(o["title"]), 120);
        o["updatedAt"] = DateTimeOffset.UtcNow.ToString("O");
        lock (_lock)
        {
            if (!JsonFileCache.Write(FileFor(id), o)) return "VYSTRAL couldn’t save the conversation. Check that the data folder isn’t read-only.";
            Trim();
        }
        return null;
    }

    public void Delete(string id)
    {
        if (!IsId(id)) return;
        lock (_lock) JsonFileCache.Delete(FileFor(id));
    }

    public void Clear()
    {
        lock (_lock)
        {
            if (!Directory.Exists(folder)) return;
            foreach (var path in Directory.EnumerateFiles(folder, "*.json").Where(p => IsId(Path.GetFileNameWithoutExtension(p))).ToList())
                JsonFileCache.Delete(path);
        }
    }

    private JsonObject? Read(string id)
    {
        try
        {
            var info = new FileInfo(FileFor(id));
            if (!info.Exists || info.Length > MaxChars * 4) return null;
            return JsonNode.Parse(File.ReadAllText(info.FullName), documentOptions: new JsonDocumentOptions { MaxDepth = 24 }) is JsonObject o && o["messages"] is JsonArray ? o : null;
        }
        catch (Exception ex) when (ex is IOException or UnauthorizedAccessException or JsonException)
        {
            return null;
        }
    }

    private void Trim()
    {
        var files = Directory.EnumerateFiles(folder, "*.json").Where(p => IsId(Path.GetFileNameWithoutExtension(p)))
            .Select(p => new FileInfo(p)).OrderByDescending(f => f.LastWriteTimeUtc).ToList();
        foreach (var old in files.Skip(MaxConversations)) JsonFileCache.Delete(old.FullName);
    }

    [GeneratedRegex(@"\A[A-Za-z0-9_-]{1,40}\z")]
    private static partial Regex IdPattern();
}
