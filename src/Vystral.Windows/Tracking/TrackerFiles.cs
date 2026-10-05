using System.Text.Json;
using System.Text.Json.Serialization;
using System.Text.RegularExpressions;

namespace Vystral.Windows.Tracking;

/// <summary>
/// The session currently being tracked, as last written by the process tracking it. It is both the
/// crash-recovery heartbeat (the end of an interrupted session is <see cref="LastSeen"/>, not just its
/// last performance sample) and the hand-over note between the app and the background tracker
/// (<see cref="Parked"/>: the session was deliberately left open for the other process to continue).
/// </summary>
public sealed record TrackerSessionNote(
    string SessionId,
    string GameId,
    string? InstallationId,
    string Source,
    DateTimeOffset Start,
    DateTimeOffset LastSeen,
    int OwnerPid,
    bool Parked);

/// <summary>
/// Small JSON state files in the data folder (no database schema change): the session note above and
/// the list of games the user doesn't want noticed outside VYSTRAL. Writes are atomic (temp file +
/// rename); reads validate everything and treat anything odd as absent.
/// </summary>
public sealed partial class TrackerFiles(string dataRoot)
{
    public const string SessionFileName = "tracker-session.json";
    public const string IgnoredFileName = "tracker-ignored.json";
    private const int MaxFileBytes = 64 * 1024;
    private const int MaxIgnored = 1000;

    private static readonly JsonSerializerOptions Json = new(JsonSerializerDefaults.Web) { DefaultIgnoreCondition = JsonIgnoreCondition.Never };
    private readonly Lock _lock = new();

    public string SessionPath => Path.Combine(dataRoot, SessionFileName);
    public string IgnoredPath => Path.Combine(dataRoot, IgnoredFileName);

    // ---------------- session note ----------------

    public TrackerSessionNote? ReadSession()
    {
        try
        {
            var text = ReadSmall(SessionPath);
            if (text is null) return null;
            var n = JsonSerializer.Deserialize<TrackerSessionNote>(text, Json);
            if (n is null || !Hex32().IsMatch(n.SessionId ?? "") || !Hex32().IsMatch(n.GameId ?? "") ||
                (n.InstallationId is not null && !Hex32().IsMatch(n.InstallationId)) ||
                !Vystral.Core.Domain.SessionSources.IsObserved(n.Source) || n.LastSeen < n.Start || n.OwnerPid < 0)
                return null;
            return n;
        }
        catch (Exception ex) when (ex is JsonException or IOException or UnauthorizedAccessException or NotSupportedException)
        {
            return null;
        }
    }

    public void WriteSession(TrackerSessionNote note)
    {
        lock (_lock) WriteAtomic(SessionPath, JsonSerializer.Serialize(note, Json));
    }

    /// <summary>Deletes the note, but only while it still describes <paramref name="sessionId"/> (null: whatever it describes).</summary>
    public void ClearSession(string? sessionId = null)
    {
        lock (_lock)
        {
            try
            {
                if (sessionId is not null && ReadSession() is { } n && n.SessionId != sessionId) return;
                File.Delete(SessionPath);
            }
            catch (Exception ex) when (ex is IOException or UnauthorizedAccessException) { }
        }
    }

    // ---------------- ignored games ----------------

    private sealed record IgnoredFile(IReadOnlyList<string> GameIds);

    public IReadOnlySet<string> ReadIgnored()
    {
        try
        {
            var text = ReadSmall(IgnoredPath);
            if (text is null) return new HashSet<string>(StringComparer.Ordinal);
            var file = JsonSerializer.Deserialize<IgnoredFile>(text, Json);
            return (file?.GameIds ?? []).Where(id => id is not null && Hex32().IsMatch(id)).Take(MaxIgnored).ToHashSet(StringComparer.Ordinal);
        }
        catch (Exception ex) when (ex is JsonException or IOException or UnauthorizedAccessException or NotSupportedException)
        {
            return new HashSet<string>(StringComparer.Ordinal);
        }
    }

    /// <summary>Adds or removes a game from the ignore list. Returns the new list.</summary>
    public IReadOnlySet<string> SetIgnored(string gameId, bool ignored)
    {
        if (!Hex32().IsMatch(gameId)) throw new ArgumentException("Invalid game id.", nameof(gameId));
        lock (_lock)
        {
            var set = new HashSet<string>(ReadIgnored(), StringComparer.Ordinal);
            var changed = ignored ? set.Count < MaxIgnored && set.Add(gameId) : set.Remove(gameId);
            if (changed) WriteAtomic(IgnoredPath, JsonSerializer.Serialize(new IgnoredFile([.. set.Order(StringComparer.Ordinal)]), Json));
            return set;
        }
    }

    // ---------------- helpers ----------------

    private static string? ReadSmall(string path)
    {
        var info = new FileInfo(path);
        if (!info.Exists || info.Length > MaxFileBytes) return null;
        // Shared read: the other process may be replacing the file at this moment.
        using var stream = new FileStream(path, FileMode.Open, FileAccess.Read, FileShare.ReadWrite | FileShare.Delete);
        using var reader = new StreamReader(stream);
        return reader.ReadToEnd();
    }

    private static void WriteAtomic(string path, string content)
    {
        try
        {
            var tmp = $"{path}.{Environment.ProcessId}.tmp";
            File.WriteAllText(tmp, content);
            File.Move(tmp, path, overwrite: true);
        }
        catch (Exception ex) when (ex is IOException or UnauthorizedAccessException)
        {
            Services.Log.Warn("tracker", "Couldn't write tracker state", new { file = Path.GetFileName(path) }, ex);
        }
    }

    [GeneratedRegex("^[0-9a-f]{32}$")]
    private static partial Regex Hex32();
}
