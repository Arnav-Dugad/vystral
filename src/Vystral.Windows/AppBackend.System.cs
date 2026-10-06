using System.Text.Json;
using Vystral.Windows.Bridge;
using Vystral.Windows.Services;

namespace Vystral.Windows;

public sealed partial class AppBackend
{
    private void RegisterSystemHandlers()
    {
        Dispatcher.Register("system.drives", _ => Task.FromResult<object?>(DriveInfo.GetDrives()
            .Where(d => d.DriveType is DriveType.Fixed or DriveType.Removable && d.IsReady)
            .Select(d => new
            {
                name = d.Name.TrimEnd('\\'),
                label = d.VolumeLabel,
                totalBytes = d.TotalSize,
                freeBytes = d.AvailableFreeSpace,
                isSystem = string.Equals(d.Name, Path.GetPathRoot(Environment.SystemDirectory), StringComparison.OrdinalIgnoreCase),
                removable = d.DriveType == DriveType.Removable,
            }).ToList()));

        Dispatcher.Register("diagnostics.info", _ => Task.FromResult<object?>(new
        {
            version = Version,
            dataPath = Paths.Root,
            database = new
            {
                path = Database.FilePath,
                sizeBytes = File.Exists(Database.FilePath) ? new FileInfo(Database.FilePath).Length : 0,
                schemaVersion = Core.Data.Database.LatestVersion,
            },
            artCacheBytes = Artwork.CacheSizeBytes() + (_liveTiles?.CacheBytes() ?? 0),
            recentAudit = Repository.RecentAudit(30).Select(a => new { at = a.At, action = a.Action, detail = a.Detail }),
            runtime = Environment.Version.ToString(),
            os = Environment.OSVersion.VersionString,
            safeMode = SafeMode,
        }));
        Dispatcher.Register("diagnostics.checkDatabase", _ => Task.FromResult<object?>(new { result = Database.CheckIntegrity() }));
        Dispatcher.Register("diagnostics.backupNow", _ =>
        {
            var dest = Path.Combine(Paths.Backups, $"manual-{DateTime.Now:yyyyMMdd-HHmmss}.db");
            Database.BackupTo(dest);
            Repository.Audit("data.backup", dest);
            return Task.FromResult<object?>(new { path = dest });
        });
        Dispatcher.Register("data.clearArtCache", _ =>
        {
            var snapshot = Library.Snapshot();
            // Keep user-chosen artwork; everything else can be re-imported or re-downloaded.
            var keep = snapshot.Games.SelectMany(g => Repository.GetArtwork(g.Id).Where(a => a.Value.IsUser).Select(a => a.Value.File))
                .Concat(_artPacks?.ReferencedFiles() ?? []); // Track N: art an art pack replaced stays restorable
            var freed = Artwork.ClearUnreferenced(keep) + (_liveTiles?.ClearCache() ?? 0); // live-tile loops are cached artwork too
            // The files are gone, so forget their rows too: otherwise nothing would ever fetch them again.
            var forgotten = Repository.ForgetAllDownloadedArtwork();
            Repository.Audit("data.clearArtCache", $"{freed} bytes, {forgotten} artwork entries");
            _events.Emit("library.changed", new { reason = "artwork" });
            // A rescan re-imports store art from disk; enrichment then re-downloads the rest, covers first.
            Task.Run(async () =>
            {
                try { await Library.ScanAsync(_life.Token); }
                catch (OperationCanceledException) { }
                catch (Exception ex) { Log.Warn("art", "Re-import after clearing the art cache failed", ex: ex); }
            });
            return Task.FromResult<object?>(new { freedBytes = freed });
        });
        Dispatcher.Register("data.exportJournal", async _ =>
        {
            var path = await _shell.PickSaveFileAsync($"vystral-journal-{DateTime.Now:yyyy-MM-dd}", ".json", "JSON file");
            if (path is null) return null;
            var snapshot = Library.Snapshot();
            var export = new
            {
                exportedAt = DateTimeOffset.Now,
                app = $"VYSTRAL {Version}",
                note = "Sessions with source 'tracked' were observed by VYSTRAL. Store playtime is shown separately as imported.",
                games = snapshot.Games.Select(g => new
                {
                    g.Title, g.Genres, g.Favorite, g.UserRating, g.Notes, trackedSeconds = g.TrackedSeconds, g.SessionCount,
                    stores = g.Installations.Select(i => new { i.Platform, i.ImportedPlaytimeMinutes, i.ImportedLastPlayed }),
                }),
                sessions = Repository.ListSessions(null, 100000).Select(s => new
                {
                    game = snapshot.Games.FirstOrDefault(g => g.Id == s.GameId)?.Title, s.Start, s.End, s.DurationSeconds, s.Source,
                    perf = s.PerfSummary is null ? (JsonElement?)null : JsonDocument.Parse(s.PerfSummary).RootElement,
                }),
            };
            var tmp = path + ".tmp";
            await File.WriteAllTextAsync(tmp, JsonSerializer.Serialize(export, new JsonSerializerOptions(JsonSerializerDefaults.Web) { WriteIndented = true }));
            File.Move(tmp, path, overwrite: true);
            Repository.Audit("data.exportJournal", path);
            return new { path };
        });
        Dispatcher.Register("data.deleteHistory", _ =>
        {
            if (IsGameActive) throw new BridgeException("busy", "Close your game before deleting history.");
            var n = Repository.DeleteTrackedHistory();
            _events.Emit("library.changed", new { reason = "history" });
            return Task.FromResult<object?>(new { deletedSessions = n });
        });
    }
}
