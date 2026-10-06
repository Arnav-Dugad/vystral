using System.Text;
using System.Text.Json;
using Vystral.Core.Data;
using Vystral.Windows.Services;

namespace Vystral.Windows.DataSources;

/// <summary>What one art pack replaced in one slot: the file it put there and what was there before (null = empty).</summary>
public sealed record ArtPackEntry(string GameId, string Kind, string File, ArtworkRow? Previous);

/// <summary>The header of one art-pack run. Entries live next to it in an append-only file.</summary>
public sealed record ArtPackManifest(string Id, string PresetId, string PresetLabel, string Scope, IReadOnlyList<string> Kinds, bool ReplacedHandPicked,
    string Started, string? Finished, string State, string? RestoredAt);

/// <summary>
/// The undo record for art packs, under &lt;data&gt;\artpacks: {id}.json (the header, rewritten atomically
/// when the run's state changes) and {id}.jsonl (one line per replaced slot, appended before the next slot
/// is touched, so even a crash mid-run leaves an accurate record). Only the newest <see cref="Keep"/> runs
/// are kept. Everything read back is validated: IDs are hex, files are cache-relative.
/// </summary>
public sealed class ArtPackManifestStore
{
    public const int Keep = 10;
    private static readonly JsonSerializerOptions Json = new(JsonSerializerDefaults.Web);
    private readonly object _lock = new();

    public string Directory { get; }

    public ArtPackManifestStore(string directory)
    {
        Directory = directory;
        System.IO.Directory.CreateDirectory(directory);
    }

    public void Save(ArtPackManifest m)
    {
        RequireId(m.Id);
        lock (_lock)
        {
            var path = Path.Combine(Directory, m.Id + ".json");
            File.WriteAllText(path + ".tmp", JsonSerializer.Serialize(m, Json));
            File.Move(path + ".tmp", path, overwrite: true);
        }
    }

    public void Append(string id, ArtPackEntry entry)
    {
        RequireId(id);
        lock (_lock)
            File.AppendAllText(Path.Combine(Directory, id + ".jsonl"), JsonSerializer.Serialize(entry, Json) + "\n", Encoding.UTF8);
    }

    public ArtPackManifest? Load(string id)
    {
        if (!IsId(id)) return null;
        try
        {
            var m = JsonSerializer.Deserialize<ArtPackManifest>(File.ReadAllText(Path.Combine(Directory, id + ".json")), Json);
            return m is not null && m.Id == id ? m : null;
        }
        catch (Exception ex) when (ex is IOException or JsonException or UnauthorizedAccessException) { return null; }
    }

    public IReadOnlyList<ArtPackEntry> Entries(string id)
    {
        if (!IsId(id)) return [];
        var path = Path.Combine(Directory, id + ".jsonl");
        if (!File.Exists(path)) return [];
        var list = new List<ArtPackEntry>();
        try
        {
            foreach (var line in File.ReadLines(path))
            {
                if (string.IsNullOrWhiteSpace(line)) continue;
                ArtPackEntry? e;
                try { e = JsonSerializer.Deserialize<ArtPackEntry>(line, Json); }
                catch (JsonException) { continue; } // a torn last line after a crash
                if (e is not null && Valid(e)) list.Add(e);
            }
        }
        catch (IOException) { }
        return list;
    }

    /// <summary>Runs, newest first.</summary>
    public IReadOnlyList<ArtPackManifest> List() =>
        new DirectoryInfo(Directory).GetFiles("*.json")
            .Select(f => Load(Path.GetFileNameWithoutExtension(f.Name)))
            .OfType<ArtPackManifest>()
            .OrderByDescending(m => m.Started, StringComparer.Ordinal)
            .ToList();

    /// <summary>Forgets all but the newest <see cref="Keep"/> runs.</summary>
    public void Prune()
    {
        foreach (var old in List().Skip(Keep))
        {
            try
            {
                File.Delete(Path.Combine(Directory, old.Id + ".json"));
                File.Delete(Path.Combine(Directory, old.Id + ".jsonl"));
            }
            catch (IOException ex) { Log.Warn("artpacks", "Couldn’t remove an old art-pack record", ex: ex); }
        }
    }

    /// <summary>Cache files any kept run could put back (so clearing the art cache never breaks an undo).</summary>
    public IEnumerable<string> ReferencedFiles() =>
        List().Where(m => m.RestoredAt is null).SelectMany(m => Entries(m.Id)).Select(e => e.Previous?.File).OfType<string>();

    public static string NewId() => Guid.NewGuid().ToString("N");

    public static bool IsId(string? id) => id is { Length: 32 } && id.All(char.IsAsciiHexDigitLower);

    private static void RequireId(string id)
    {
        if (!IsId(id)) throw new ArgumentException("Invalid art-pack ID.", nameof(id));
    }

    internal static bool SafeRelative(string? file) =>
        file is { Length: > 0 and <= 260 } && !file.Contains("..") && !Path.IsPathRooted(file) && file.IndexOfAny([':', '\0']) < 0;

    private static bool Valid(ArtPackEntry e) =>
        e.GameId is { Length: > 0 and <= 64 } && e.GameId.All(char.IsAsciiLetterOrDigit) &&
        e.Kind is "cover" or "hero" or "logo" && SafeRelative(e.File) &&
        (e.Previous is null || (SafeRelative(e.Previous.File) && e.Previous.Source is { Length: > 0 and <= 40 }));
}
