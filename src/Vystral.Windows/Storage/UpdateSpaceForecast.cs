using System.Globalization;
using Vystral.Core.Parsing;

namespace Vystral.Windows.Storage;

/// <summary>The fields of steamapps\appmanifest_&lt;appid&gt;.acf the space forecast uses (all read-only).</summary>
public sealed record AppManifestInfo(
    string AppId,
    string Name,
    long StateFlags,
    string? BuildId,
    string? TargetBuildId,
    long BytesToDownload,
    long BytesDownloaded,
    long BytesToStage,
    long BytesStaged,
    long SizeOnDisk,
    long UpdateResult,
    long AutoUpdateBehavior,
    long ScheduledAutoUpdate);

/// <summary>A Steam library folder (the folder holding <c>steamapps</c>) and the volume it lives on.</summary>
public sealed record LibraryVolume(string LibraryPath, VolumeSpace Volume, IReadOnlyList<AppManifestInfo> Manifests);

/// <summary>Key = the volume mount point (e.g. <c>D:\</c>), Name = what people call it (e.g. <c>D:</c>).</summary>
public sealed record VolumeSpace(string Key, string Name, string? Label, long FreeBytes, long TotalBytes);

/// <summary>
/// One pending install or update. Kind: update | install. Phase: queued | downloading | staging | paused.
/// Fit (on its own, against the drive's free space today): ok | tight | short | unknown.
/// <c>NeedBytes</c> is null while Steam hasn't worked out the update's size yet.
/// </summary>
public sealed record PendingUpdateDto(
    string AppId,
    string? GameId,
    string Name,
    string Kind,
    string Phase,
    long? NeedBytes,
    long DownloadRemaining,
    long StageRemaining,
    long SizeOnDisk,
    string Fit,
    bool WhenLaunched,
    string? ScheduledAt,
    long? LastResult);

/// <summary>Status: ok | tight | short. <c>AfterBytes</c> = free space once every known pending update has the room it needs.</summary>
public sealed record DriveForecastDto(
    string Drive,
    string? Label,
    long FreeBytes,
    long TotalBytes,
    long NeedBytes,
    long AfterBytes,
    long TightBelowBytes,
    string Status,
    IReadOnlyList<PendingUpdateDto> Updates);

/// <summary>Status: none (nothing pending) | ok | tight | short (the worst drive). Available = Steam was found.</summary>
public sealed record DiskForecastDto(bool Available, string Status, string ScannedAt, int PendingCount, IReadOnlyList<DriveForecastDto> Drives);

/// <summary>
/// Track P: warns before a Steam update won't fit. Pure functions over the values Steam writes into
/// its app manifests; nothing here touches the disk.
///
/// <para><b>How much room an update needs.</b> Steam downloads compressed chunks into
/// <c>steamapps\downloading\&lt;appid&gt;</c> (<c>BytesToDownload</c>, progress in <c>BytesDownloaded</c>), then
/// stages the rebuilt files (<c>BytesToStage</c>, progress in <c>BytesStaged</c>) and only then commits them
/// over the old files and deletes the chunks. At the peak, the chunks and the staged files are both on
/// disk next to the old game. Bytes already downloaded or staged are already missing from today's
/// free space, so the room an update still needs is
/// <c>max(0, BytesToDownload − BytesDownloaded) + max(0, BytesToStage − BytesStaged)</c>.
/// This is a conservative upper bound: when the commit finishes, the chunks are deleted and the
/// replaced files freed. Several updates on one drive are added up, which again errs on the safe side
/// (Steam runs them one at a time and frees each one's working space before the next).</para>
///
/// <para><b>When an update is pending.</b> Not fully installed (an install in progress), the
/// <i>update required</i> bit, any update-in-progress bit, or a different target build with bytes
/// still to fetch. When Steam has flagged an update but its counters still describe the previous,
/// finished one (everything downloaded and staged, nothing running), the size isn't known yet.</para>
/// </summary>
public static class UpdateSpaceForecast
{
    // EAppState bits (the same ones InstallWatcher uses).
    internal const long FlagUpdateRequired = 2, FlagFullyInstalled = 4, FlagUpdateRunning = 256, FlagUpdatePaused = 512,
        FlagUpdateStarted = 1024, FlagUninstalling = 2048, FlagValidating = 131072, FlagAddingFiles = 262144, FlagPreallocating = 524288,
        FlagDownloading = 1048576, FlagStaging = 2097152, FlagCommitting = 4194304;

    internal const long ActiveMask = FlagUpdateRunning | FlagUpdatePaused | FlagUpdateStarted | FlagAddingFiles | FlagPreallocating |
                                     FlagDownloading | FlagStaging | FlagCommitting;

    /// <summary>"Under about 5 % free": 5 % of the drive, but never below 1 GB or above 50 GB (on a 4 TB drive, 200 GB free isn't tight).</summary>
    public static long TightThreshold(long totalBytes) =>
        Math.Clamp((long)(Math.Max(0, totalBytes) * 0.05), 1L << 30, 50L << 30);

    public static AppManifestInfo? ParseManifest(string text)
    {
        try
        {
            var s = Vdf.Parse(text)["AppState"];
            var appId = s?.GetString("appid");
            if (s is null || appId is null || appId.Length is 0 or > 10 || !appId.All(char.IsAsciiDigit)) return null;
            var name = Integrations.SteamWebApiClient.CleanText(s.GetString("name"), 120) ?? $"Steam app {appId}";
            static long N(VdfNode n, string key) => Math.Max(0, n.GetLong(key) ?? 0);
            static string? Build(VdfNode n, string key) => n.GetString(key) is { Length: > 0 and <= 20 } b && b.All(char.IsAsciiDigit) ? b : null;
            return new AppManifestInfo(appId, name, s.GetLong("StateFlags") ?? 0, Build(s, "buildid"), Build(s, "TargetBuildID"),
                N(s, "BytesToDownload"), N(s, "BytesDownloaded"), N(s, "BytesToStage"), N(s, "BytesStaged"), N(s, "SizeOnDisk"),
                s.GetLong("UpdateResult") ?? 0, s.GetLong("AutoUpdateBehavior") ?? 0, N(s, "ScheduledAutoUpdate"));
        }
        catch (FormatException)
        {
            return null;
        }
    }

    public static long DownloadRemaining(AppManifestInfo m) => Math.Max(0, m.BytesToDownload - m.BytesDownloaded);
    public static long StageRemaining(AppManifestInfo m) => Math.Max(0, m.BytesToStage - m.BytesStaged);

    /// <summary>update | install | null (nothing pending, or Steam is uninstalling it).</summary>
    public static string? PendingKind(AppManifestInfo m)
    {
        var f = m.StateFlags;
        if ((f & FlagUninstalling) != 0 || f == 0) return null;
        var remaining = DownloadRemaining(m) + StageRemaining(m);
        var flagged = (f & (FlagUpdateRequired | ActiveMask)) != 0;
        // Not fully installed: an install in progress (bit 1 alone means "uninstalled", nothing to fetch).
        if ((f & FlagFullyInstalled) == 0) return flagged || remaining > 0 ? "install" : null;
        var buildMismatch = m.TargetBuildId is not null && m.BuildId is not null && m.TargetBuildId != "0" && m.TargetBuildId != m.BuildId;
        return flagged || (buildMismatch && remaining > 0) ? "update" : null;
    }

    public static string Phase(AppManifestInfo m)
    {
        var f = m.StateFlags;
        if ((f & FlagUpdatePaused) != 0) return "paused";
        if ((f & (FlagStaging | FlagCommitting)) != 0) return "staging";
        if ((f & (FlagDownloading | FlagPreallocating | FlagAddingFiles | FlagUpdateRunning)) != 0) return "downloading";
        return "queued";
    }

    /// <summary>The room a pending update still needs, or null when Steam hasn't sized it yet (see the class remarks).</summary>
    public static long? NeedBytes(AppManifestInfo m)
    {
        var remaining = DownloadRemaining(m) + StageRemaining(m);
        if (remaining > 0) return remaining;
        var running = (m.StateFlags & (ActiveMask & ~FlagUpdatePaused)) != 0;
        // Counters left over from the last finished update: the new one isn't sized yet.
        return running ? 0 : null;
    }

    public static string Fit(long? need, long free, long tightBelow) =>
        need is not { } n ? "unknown" : n > free ? "short" : free - n < tightBelow ? "tight" : "ok";

    /// <summary>Groups pending updates by volume (libraries sharing a drive are added together) and rates each drive.</summary>
    public static DiskForecastDto Build(IReadOnlyList<LibraryVolume> libraries, IReadOnlyDictionary<string, string> appToGame, DateTimeOffset now)
    {
        var drives = new List<DriveForecastDto>();
        foreach (var group in libraries.GroupBy(l => l.Volume.Key, StringComparer.OrdinalIgnoreCase))
        {
            var volume = group.First().Volume;
            var tight = TightThreshold(volume.TotalBytes);
            var seen = new HashSet<string>(StringComparer.Ordinal);
            var updates = new List<PendingUpdateDto>();
            foreach (var m in group.SelectMany(l => l.Manifests))
            {
                if (!seen.Add(m.AppId) || PendingKind(m) is not { } kind) continue;
                var need = NeedBytes(m);
                string? scheduled = m.ScheduledAutoUpdate is > 946684800 and < 32503680000 // 2000..3000
                    ? DateTimeOffset.FromUnixTimeSeconds(m.ScheduledAutoUpdate).ToString("O") : null;
                updates.Add(new PendingUpdateDto(m.AppId, appToGame.TryGetValue(m.AppId, out var gid) ? gid : null, m.Name, kind, Phase(m), need,
                    DownloadRemaining(m), StageRemaining(m), m.SizeOnDisk, Fit(need, volume.FreeBytes, tight), m.AutoUpdateBehavior == 1,
                    scheduled, m.UpdateResult != 0 ? m.UpdateResult : null));
            }
            if (updates.Count == 0) continue;
            updates.Sort((a, b) => (b.NeedBytes ?? -1).CompareTo(a.NeedBytes ?? -1));
            var total = updates.Sum(u => u.NeedBytes ?? 0);
            var after = volume.FreeBytes - total;
            var status = after < 0 ? "short" : after < tight ? "tight" : "ok";
            drives.Add(new DriveForecastDto(volume.Name, volume.Label, volume.FreeBytes, volume.TotalBytes, total, after, tight, status, updates));
        }
        drives.Sort((a, b) => Rank(b.Status).CompareTo(Rank(a.Status)) != 0 ? Rank(b.Status).CompareTo(Rank(a.Status)) : string.Compare(a.Drive, b.Drive, StringComparison.OrdinalIgnoreCase));
        var worst = drives.Count == 0 ? "none" : drives.MaxBy(d => Rank(d.Status))!.Status;
        return new DiskForecastDto(true, worst, now.ToString("O"), drives.Sum(d => d.Updates.Count), drives);
    }

    internal static int Rank(string status) => status switch { "short" => 2, "tight" => 1, _ => 0 };

    /// <summary>"D:" for a drive root, the mount folder otherwise.</summary>
    public static string DriveName(string volumeKey)
    {
        var trimmed = volumeKey.TrimEnd('\\');
        return trimmed.Length == 2 && trimmed[1] == ':' ? trimmed.ToUpper(CultureInfo.InvariantCulture) : trimmed;
    }

    /// <summary>A short signature that changes only when something worth telling the page about changes (sizes rounded to 256 MB).</summary>
    public static string Signature(DiskForecastDto f) =>
        string.Join('|', f.Drives.Select(d =>
            $"{d.Drive}:{d.Status}:{d.FreeBytes >> 28}:" + string.Join(',', d.Updates.Select(u => $"{u.AppId}/{u.Phase}/{(u.NeedBytes is { } n ? (n >> 28).ToString(CultureInfo.InvariantCulture) : "?")}/{u.Fit}"))));
}
