using System.Runtime.InteropServices;
using System.Security.Cryptography;
using System.Text.Json;
using System.Text.Json.Serialization;

namespace Vystral.Windows.Services.Rollback;

/// <summary>The previous version's full update package, kept for a silent rollback.</summary>
public sealed record PreservedPackage(string PackageId, string Version, string FileName, long Size, string Sha256, string Sha1, string PreservedAt);

/// <summary>The few file operations the package store needs (faked in tests).</summary>
public interface IRollbackFileSystem
{
    bool FileExists(string path);
    long FileLength(string path);
    Stream OpenRead(string path);
    void CreateDirectory(string path);
    /// <summary>Hard-links <paramref name="source"/> to <paramref name="dest"/> when they share a volume (no extra disk space), else copies.</summary>
    void LinkOrCopy(string source, string dest);
    void Move(string source, string dest);
    string? ReadAllText(string path);
    void WriteAllText(string path, string text);
    void Delete(string path);
    IEnumerable<string> EnumerateFiles(string directory, string pattern);
}

/// <summary>
/// Keeps exactly one previous full package in <c>update/rollback</c> under the data folder.
/// Velopack deletes every other package from its own packages folder as soon as an update has
/// downloaded, so the running version's package is preserved just before each download. It is
/// hard-linked when possible (Velopack's folder is on the same drive), so it costs no extra space
/// until Velopack removes its own copy. Its SHA-256 is recorded at that moment and checked again
/// before it is ever applied.
/// </summary>
public sealed class RollbackPackageStore(string directory, IRollbackFileSystem? files = null)
{
    private const string ManifestName = "package.json";
    private static readonly JsonSerializerOptions Json = new() { WriteIndented = true };
    private readonly IRollbackFileSystem _fs = files ?? new PhysicalRollbackFileSystem();

    public string Directory { get; } = directory;
    private string ManifestPath => Path.Combine(Directory, ManifestName);

    /// <summary>The preserved package, if its manifest and file are present and the size still matches.</summary>
    public PreservedPackage? Get()
    {
        try
        {
            var text = _fs.ReadAllText(ManifestPath);
            if (text is null) return null;
            var pkg = JsonSerializer.Deserialize<PreservedPackage>(text);
            if (pkg is null || !AppVersion.IsValid(pkg.Version) || !IsSafeFileName(pkg.FileName)) return null;
            var path = Path.Combine(Directory, pkg.FileName);
            return _fs.FileExists(path) && _fs.FileLength(path) == pkg.Size ? pkg : null;
        }
        catch (Exception ex) when (ex is IOException or JsonException or UnauthorizedAccessException)
        {
            Log.Warn("rollback", "Preserved package manifest unreadable", ex: ex);
            return null;
        }
    }

    /// <summary>
    /// Preserves <paramref name="sourcePath"/> (the running version's full package). Returns the
    /// record, or the existing one when that version is already preserved. Other packages are removed.
    /// </summary>
    public PreservedPackage? Preserve(string packageId, string version, string sourcePath, DateTimeOffset now)
    {
        if (!AppVersion.IsValid(version) || !_fs.FileExists(sourcePath)) return null;
        var existing = Get();
        var size = _fs.FileLength(sourcePath);
        if (existing is not null && AppVersion.Compare(existing.Version, version) == 0 && existing.Size == size) return existing;

        _fs.CreateDirectory(Directory);
        var fileName = $"{SafeId(packageId)}-{version}-full.nupkg";
        var dest = Path.Combine(Directory, fileName);
        var partial = dest + ".partial";
        if (_fs.FileExists(partial)) _fs.Delete(partial);
        _fs.LinkOrCopy(sourcePath, partial);
        var (sha256, sha1) = Hash(partial);
        if (_fs.FileExists(dest)) _fs.Delete(dest);
        _fs.Move(partial, dest);

        var pkg = new PreservedPackage(packageId, version, fileName, size, sha256, sha1, now.ToString("O"));
        _fs.WriteAllText(ManifestPath, JsonSerializer.Serialize(pkg, Json));
        foreach (var other in _fs.EnumerateFiles(Directory, "*.nupkg").Where(f => !string.Equals(Path.GetFileName(f), fileName, StringComparison.OrdinalIgnoreCase)).ToList())
            TryDelete(other);
        Log.Info("rollback", "Preserved the current version's package", new { version, size, sha256 });
        return pkg;
    }

    /// <summary>True when the file on disk still has the SHA-256 recorded when it was preserved.</summary>
    public bool Verify(PreservedPackage pkg)
    {
        try
        {
            var path = Path.Combine(Directory, pkg.FileName);
            if (!IsSafeFileName(pkg.FileName) || !_fs.FileExists(path) || _fs.FileLength(path) != pkg.Size) return false;
            return string.Equals(Hash(path).Sha256, pkg.Sha256, StringComparison.OrdinalIgnoreCase);
        }
        catch (Exception ex) when (ex is IOException or UnauthorizedAccessException)
        {
            Log.Warn("rollback", "Couldn't verify the preserved package", ex: ex);
            return false;
        }
    }

    /// <summary>
    /// Writes the one-entry Velopack feed (<c>releases.{channel}.json</c>) that lets Velopack's own
    /// <c>SimpleFileSource</c> "update" to the preserved package. Velopack checks the file against
    /// these hashes again when it copies it into its packages folder.
    /// </summary>
    public string WriteFeed(PreservedPackage pkg, string channel)
    {
        var feed = new FeedFile([new FeedAsset(pkg.PackageId, pkg.Version, "Full", pkg.FileName, pkg.Sha1, pkg.Sha256, pkg.Size)]);
        var path = Path.Combine(Directory, $"releases.{SafeId(channel)}.json");
        _fs.WriteAllText(path, JsonSerializer.Serialize(feed));
        return path;
    }

    /// <summary>Removes the preserved package once it can no longer be a rollback target.</summary>
    public void DeleteIfOlderThan(string version)
    {
        var pkg = Get();
        if (pkg is null || AppVersion.Compare(pkg.Version, version) >= 0) return;
        TryDelete(Path.Combine(Directory, pkg.FileName));
        TryDelete(ManifestPath);
        Log.Info("rollback", "Removed the preserved package of an older version", new { pkg.Version, current = version });
    }

    private (string Sha256, string Sha1) Hash(string path)
    {
        using var stream = _fs.OpenRead(path);
        using var h256 = IncrementalHash.CreateHash(HashAlgorithmName.SHA256);
        using var h1 = IncrementalHash.CreateHash(HashAlgorithmName.SHA1); // Velopack's feed format carries both
        var buffer = new byte[1 << 20];
        int read;
        while ((read = stream.Read(buffer, 0, buffer.Length)) > 0)
        {
            h256.AppendData(buffer, 0, read);
            h1.AppendData(buffer, 0, read);
        }
        return (Convert.ToHexString(h256.GetHashAndReset()), Convert.ToHexString(h1.GetHashAndReset()));
    }

    private void TryDelete(string path)
    {
        try { if (_fs.FileExists(path)) _fs.Delete(path); }
        catch (Exception ex) when (ex is IOException or UnauthorizedAccessException) { Log.Warn("rollback", "Couldn't delete a file", new { path }, ex); }
    }

    private static string SafeId(string s) => new([.. s.Where(c => char.IsAsciiLetterOrDigit(c) || c is '.' or '_' or '-')]);

    private static bool IsSafeFileName(string name) =>
        name.Length is > 0 and < 120 && name.EndsWith(".nupkg", StringComparison.OrdinalIgnoreCase) &&
        name.IndexOfAny(Path.GetInvalidFileNameChars()) < 0 && !name.Contains("..");

    private sealed record FeedFile(IReadOnlyList<FeedAsset> Assets);

    private sealed record FeedAsset(
        string PackageId, string Version, string Type, string FileName,
        [property: JsonPropertyName("SHA1")] string Sha1,
        [property: JsonPropertyName("SHA256")] string Sha256,
        long Size);
}

public sealed partial class PhysicalRollbackFileSystem : IRollbackFileSystem
{
    public bool FileExists(string path) => File.Exists(path);
    public long FileLength(string path) => new FileInfo(path).Length;
    public Stream OpenRead(string path) => new FileStream(path, FileMode.Open, FileAccess.Read, FileShare.Read | FileShare.Delete, 1 << 16, FileOptions.SequentialScan);
    public void CreateDirectory(string path) => System.IO.Directory.CreateDirectory(path);
    public void Move(string source, string dest) => File.Move(source, dest, overwrite: true);
    public string? ReadAllText(string path) => File.Exists(path) ? File.ReadAllText(path) : null;
    public void Delete(string path) => File.Delete(path);
    public IEnumerable<string> EnumerateFiles(string directory, string pattern) =>
        System.IO.Directory.Exists(directory) ? System.IO.Directory.EnumerateFiles(directory, pattern) : [];

    public void WriteAllText(string path, string text)
    {
        var tmp = path + ".tmp";
        File.WriteAllText(tmp, text);
        File.Move(tmp, path, overwrite: true);
    }

    public void LinkOrCopy(string source, string dest)
    {
        if (CreateHardLink(dest, source, IntPtr.Zero)) return;
        File.Copy(source, dest, overwrite: true);
    }

    [LibraryImport("kernel32.dll", EntryPoint = "CreateHardLinkW", StringMarshalling = StringMarshalling.Utf16, SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static partial bool CreateHardLink(string fileName, string existingFileName, IntPtr securityAttributes);
}
