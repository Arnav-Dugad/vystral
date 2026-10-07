using System.Text;
using System.Text.Json;
using Vystral.Windows.Services.Rollback;

namespace Vystral.Windows.Services.Startup;

/// <summary>A validated first-paint snapshot ready to hand to the interface.</summary>
/// <param name="PayloadJson">The interface's Home view-model, re-serialized by the host (always plain JSON data).</param>
public sealed record FirstPaintSnapshot(string PayloadJson, string AppVersion, DateTimeOffset SavedAt, string? Theme);

/// <summary>
/// Track AA: the "first paint" cache. The interface saves a compact copy of what Home last showed
/// (the hero, the games on each shelf with their already-cached cover URLs, a few numbers, the theme);
/// on the next start the host hands it to the page before any script runs, so Home appears at once and
/// is then reconciled with the live library. Stored as <c>ui-state/first-paint.json</c> in the data folder:
/// no migration, nothing secret, and losing it only means one ordinary (live) start.
/// <para>
/// The file is an envelope <c>{ schema, appVersion, savedAt, payload }</c>. It is ignored, never an error,
/// when it is missing, unreadable, from another schema or another VYSTRAL version (the interface that
/// wrote it may have had a different shape), older than <see cref="MaxAge"/>, or larger than
/// <see cref="MaxBytes"/>. The payload itself is opaque to the host apart from these structural limits;
/// the interface validates every field again before using it.
/// </para>
/// </summary>
public sealed class FirstPaintStore(string dataRoot)
{
    public const int Schema = 1;
    /// <summary>Well under the bridge's 256 KB message limit, and enough for ~120 games.</summary>
    public const int MaxBytes = 192 * 1024;
    public const int MaxDepth = 12;
    public const int MaxStringLength = 2_000;
    public const int MaxArrayLength = 500;
    public static readonly TimeSpan MaxAge = TimeSpan.FromDays(45);
    private static readonly string[] Themes = ["obsidian", "oled", "light", "contrast"];

    private readonly Lock _lock = new();

    public string FilePath => Path.Combine(dataRoot, "ui-state", "first-paint.json");

    /// <summary>The snapshot to use for this start, or null (with the reason, for the log). Never throws.</summary>
    public FirstPaintSnapshot? Load(string appVersion, DateTimeOffset now, out string reason)
    {
        string text;
        try
        {
            lock (_lock)
            {
                var info = new FileInfo(FilePath);
                if (!info.Exists) { reason = "none"; return null; }
                if (info.Length > MaxBytes + 1024) { reason = "tooLarge"; return null; }
                text = File.ReadAllText(FilePath, Encoding.UTF8);
            }
        }
        catch (Exception ex) when (ex is IOException or UnauthorizedAccessException)
        {
            reason = "unreadable";
            return null;
        }
        return Parse(text, appVersion, now, out reason);
    }

    /// <summary>Validates an envelope (pure; used by <see cref="Load"/> and tests).</summary>
    public static FirstPaintSnapshot? Parse(string text, string appVersion, DateTimeOffset now, out string reason)
    {
        try
        {
            using var doc = JsonDocument.Parse(text, new JsonDocumentOptions { MaxDepth = MaxDepth + 2 });
            var root = doc.RootElement;
            if (root.ValueKind != JsonValueKind.Object) { reason = "corrupt"; return null; }
            if (!root.TryGetProperty("schema", out var schema) || schema.ValueKind != JsonValueKind.Number || !schema.TryGetInt32(out var s) || s != Schema)
            {
                reason = "otherSchema";
                return null;
            }
            if (!root.TryGetProperty("appVersion", out var v) || v.ValueKind != JsonValueKind.String || v.GetString() is not { } version)
            {
                reason = "corrupt";
                return null;
            }
            if (!AppVersion.IsValid(appVersion) || !AppVersion.IsValid(version) || AppVersion.Compare(version, appVersion) != 0)
            {
                reason = "otherVersion";
                return null;
            }
            if (!root.TryGetProperty("savedAt", out var at) || at.ValueKind != JsonValueKind.String || !DateTimeOffset.TryParse(at.GetString(), out var savedAt))
            {
                reason = "corrupt";
                return null;
            }
            if (savedAt > now.AddMinutes(5) || now - savedAt > MaxAge)
            {
                reason = "stale";
                return null;
            }
            if (!root.TryGetProperty("payload", out var payload) || ValidatePayload(payload) is { } problem)
            {
                reason = "corrupt";
                return null;
            }
            reason = "ok";
            return new FirstPaintSnapshot(Reserialize(payload), version, savedAt, ThemeOf(payload));
        }
        catch (JsonException)
        {
            reason = "corrupt";
            return null;
        }
    }

    /// <summary>Stores a new snapshot (atomically). Throws <see cref="ArgumentException"/> for an invalid payload.</summary>
    public void Save(JsonElement payload, string appVersion, DateTimeOffset now)
    {
        if (ValidatePayload(payload) is { } problem) throw new ArgumentException(problem);
        if (!AppVersion.IsValid(appVersion)) throw new ArgumentException("Invalid version.");
        var json = Envelope(payload, appVersion, now);
        if (Encoding.UTF8.GetByteCount(json) > MaxBytes + 1024) throw new ArgumentException("The snapshot is too large.");
        lock (_lock)
        {
            Directory.CreateDirectory(Path.GetDirectoryName(FilePath)!);
            var tmp = FilePath + ".tmp";
            File.WriteAllText(tmp, json, new UTF8Encoding(false));
            File.Move(tmp, FilePath, overwrite: true);
        }
    }

    /// <summary>Removes the snapshot (empty library, onboarding again, database reset). Never throws.</summary>
    public void Clear()
    {
        try
        {
            lock (_lock)
            {
                if (File.Exists(FilePath)) File.Delete(FilePath);
            }
        }
        catch (Exception ex) when (ex is IOException or UnauthorizedAccessException)
        {
            Log.Warn("startup", "Couldn't remove the first-paint snapshot", ex: ex);
        }
    }

    public static string Envelope(JsonElement payload, string appVersion, DateTimeOffset savedAt) =>
        JsonSerializer.Serialize(new { schema = Schema, appVersion, savedAt = savedAt.ToString("O"), payload });

    /// <summary>
    /// The document-created script that hands the snapshot to the page. The payload was parsed and
    /// re-serialized by System.Text.Json, so it is a JSON value (a data literal, never code), with
    /// <c>&lt;</c>, <c>&gt;</c>, <c>&amp;</c>, quotes and line separators escaped.
    /// </summary>
    public static string Script(FirstPaintSnapshot snapshot) => "globalThis.__vystralFirstPaint=" + snapshot.PayloadJson + ";";

    /// <summary>Null when the payload is acceptable, else what is wrong with it.</summary>
    public static string? ValidatePayload(JsonElement payload)
    {
        if (payload.ValueKind != JsonValueKind.Object) return "The snapshot must be an object.";
        if (!payload.TryGetProperty("v", out var v) || v.ValueKind != JsonValueKind.Number || !v.TryGetInt32(out var n) || n is < 1 or > 1000)
            return "The snapshot has no valid version.";
        var budget = MaxBytes;
        return Walk(payload, 0, ref budget);
    }

    private static string? Walk(JsonElement e, int depth, ref int budget)
    {
        if (depth > MaxDepth) return "The snapshot is nested too deeply.";
        switch (e.ValueKind)
        {
            case JsonValueKind.Object:
                foreach (var p in e.EnumerateObject())
                {
                    if (p.Name.Length > 64) return "The snapshot has an invalid field name.";
                    budget -= p.Name.Length + 4;
                    if (Walk(p.Value, depth + 1, ref budget) is { } problem) return problem;
                }
                break;
            case JsonValueKind.Array:
                if (e.GetArrayLength() > MaxArrayLength) return "The snapshot has a list that is too long.";
                foreach (var item in e.EnumerateArray())
                {
                    if (Walk(item, depth + 1, ref budget) is { } problem) return problem;
                }
                break;
            case JsonValueKind.String:
                var s = e.GetString()!;
                if (s.Length > MaxStringLength) return "The snapshot has a text that is too long.";
                if (s.Any(c => char.IsControl(c) && c is not ('\n' or '\t'))) return "The snapshot contains invalid characters.";
                budget -= s.Length + 2;
                break;
            default:
                budget -= 8;
                break;
        }
        return budget < 0 ? "The snapshot is too large." : null;
    }

    private static string Reserialize(JsonElement payload) => JsonSerializer.Serialize(payload);

    private static string? ThemeOf(JsonElement payload) =>
        payload.TryGetProperty("appearance", out var a) && a.ValueKind == JsonValueKind.Object &&
        a.TryGetProperty("theme", out var t) && t.ValueKind == JsonValueKind.String && Themes.Contains(t.GetString())
            ? t.GetString()
            : null;
}
