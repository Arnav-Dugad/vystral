using Vystral.Windows.Storage;

namespace Vystral.Windows;

/// <summary>
/// Track C1: library correctness. Xbox package sizes are measured in the background after scans (so Storage Studio
/// sees Xbox games); the Steam "no longer owned" notice is in AppBackend.SteamAccount.cs.
/// </summary>
public sealed partial class AppBackend
{
    private PackageSizeService _packageSizes = null!;

    private void RegisterLibraryCorrectnessHandlers()
    {
        _packageSizes = new PackageSizeService(Repository, _events, () => IsGameActive);
        Library.ScanCompleted += () => _packageSizes.Poke(_life.Token);
        // Also once a little after start, for libraries whose startup didn't scan.
        _ = Task.Run(async () =>
        {
            try
            {
                await Task.Delay(TimeSpan.FromSeconds(45), _life.Token);
                if (!SafeMode) _packageSizes.Poke(_life.Token);
            }
            catch (OperationCanceledException) { }
        });
    }

    /// <summary>A single-store rescan of Xbox may find new or updated packages to measure.</summary>
    private void PokePackageSizes() => _packageSizes?.Poke(_life.Token);
}
