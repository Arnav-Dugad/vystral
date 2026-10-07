using System.Security.Cryptography;
using System.Text;
using System.Text.Json;

namespace Vystral.Windows.Services;

/// <summary>
/// Track W: small JSON cache files in the data folder (no database migration needed). Reads are
/// size-capped and tolerant (an unreadable or oversized file reads as "nothing cached"); writes are
/// atomic (temporary file, then move). Callers validate everything they read back.
/// </summary>
public static class JsonFileCache
{
    public static readonly JsonSerializerOptions Options = new(JsonSerializerDefaults.Web) { WriteIndented = false, MaxDepth = 32 };

    public static T? Read<T>(string path, long maxBytes) where T : class
    {
        try
        {
            var info = new FileInfo(path);
            if (!info.Exists || info.Length > maxBytes) return null;
            return JsonSerializer.Deserialize<T>(File.ReadAllText(path), Options);
        }
        catch (Exception ex) when (ex is IOException or UnauthorizedAccessException or JsonException or NotSupportedException)
        {
            Log.Warn("cache", "A cache file was unreadable; starting fresh", new { file = Path.GetFileName(path), error = ex.GetType().Name });
            return null;
        }
    }

    public static bool Write<T>(string path, T value)
    {
        try
        {
            Directory.CreateDirectory(Path.GetDirectoryName(path)!);
            var tmp = path + ".tmp";
            File.WriteAllText(tmp, JsonSerializer.Serialize(value, Options));
            File.Move(tmp, path, overwrite: true);
            return true;
        }
        catch (Exception ex) when (ex is IOException or UnauthorizedAccessException)
        {
            Log.Warn("cache", "Couldn't save a cache file", new { file = Path.GetFileName(path), error = ex.GetType().Name });
            return false;
        }
    }

    public static void Delete(string path)
    {
        try { if (File.Exists(path)) File.Delete(path); }
        catch (Exception ex) when (ex is IOException or UnauthorizedAccessException) { Log.Warn("cache", "Couldn't remove a cache file", new { file = Path.GetFileName(path) }); }
    }

    /// <summary>An opaque, stable stand-in for a SteamID so cache files never hold the ID itself.</summary>
    public static string AccountKey(string steamId) =>
        Convert.ToHexStringLower(SHA256.HashData(Encoding.UTF8.GetBytes("vystral-account:" + steamId)))[..16];
}
