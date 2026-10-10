using System.Text.Json;
using Vystral.Core.Health;

namespace Vystral.Windows.Services.Startup;

/// <summary>
/// Track D6: <c>update/start-history.json</c>, one small record per start (time, version, outcome) for the crash-free
/// streak in About. Written only by the app (never the background tracker); size-capped, validated on read, atomic
/// writes. Losing it only restarts the count, which the card then says.
/// </summary>
public sealed class StartHistoryStore(string dataRoot)
{
    private const long MaxBytes = 64 * 1024;
    private static readonly JsonSerializerOptions Json = new(JsonSerializerDefaults.Web);
    private readonly Lock _lock = new();

    public string FilePath { get; } = Path.Combine(dataRoot, "update", "start-history.json");

    private sealed class Shape
    {
        public int Version { get; set; } = 1;
        public List<StartRecord> Starts { get; set; } = [];
    }

    public IReadOnlyList<StartRecord> Load()
    {
        lock (_lock)
        {
            try
            {
                var info = new FileInfo(FilePath);
                if (!info.Exists || info.Length > MaxBytes) return [];
                var shape = JsonSerializer.Deserialize<Shape>(File.ReadAllText(FilePath), Json);
                return (shape?.Starts ?? []).Where(s => s is not null && s.At is { Length: <= 40 } && s.Version is { Length: <= 32 } && s.Outcome is { Length: <= 16 })
                    .TakeLast(StartStreak.MaxRecords).ToList();
            }
            catch (Exception ex) when (ex is IOException or UnauthorizedAccessException or JsonException or NotSupportedException)
            {
                Log.Warn("startup", "The start history was unreadable; starting a new one", new { error = ex.GetType().Name });
                return [];
            }
        }
    }

    public void Update(Func<IReadOnlyList<StartRecord>, List<StartRecord>> change)
    {
        lock (_lock)
        {
            var next = change(Load());
            try
            {
                Directory.CreateDirectory(Path.GetDirectoryName(FilePath)!);
                var tmp = FilePath + ".tmp";
                File.WriteAllText(tmp, JsonSerializer.Serialize(new Shape { Starts = next }, Json));
                File.Move(tmp, FilePath, overwrite: true);
            }
            catch (Exception ex) when (ex is IOException or UnauthorizedAccessException)
            {
                Log.Warn("startup", "Couldn't save the start history", new { error = ex.GetType().Name });
            }
        }
    }
}
