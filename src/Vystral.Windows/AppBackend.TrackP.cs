using Vystral.Windows.Services;
using Vystral.Windows.Storage;

namespace Vystral.Windows;

// Track P parameter records.
public sealed record FriendsActivityParams(bool? Force);

/// <summary>
/// Track P: friends' activity on Home (opt-in Steam Web API reads of the user's own friends list and
/// their public status) and the update-space forecast (Steam app manifests + free space, read-only).
/// </summary>
public sealed partial class AppBackend
{
    private FriendsActivityService _friends = null!;
    private UpdateSpaceService _updateSpace = null!;

    private void RegisterTrackPHandlers()
    {
        _friends = new FriendsActivityService(_steamKeys, _steamApi, Settings, Artwork, () => _steamAccount.SelectedSteamId(), Repository.SteamAppToGame)
        {
            IsGameActive = () => IsGameActive,
        };
        Settings.Changed += key =>
        {
            if ((key is "*" or FriendsActivityService.SettingKey) && !Settings.GetBool(FriendsActivityService.SettingKey)) _friends.Forget();
        };
        Dispatcher.Register<FriendsActivityParams>("friends.activity", async (p, ct) =>
        {
            if (SafeMode) return new FriendsActivityDto("unavailable", "VYSTRAL is in safe mode, so it doesn’t contact Steam.", null, 0, [], [], false, null);
            return await _friends.GetAsync(p.Force == true, ct);
        });

        _updateSpace = new UpdateSpaceService(_steam.FindSteamPath, Repository.SteamAppToGame, _events, () => IsGameActive, new WindowsVolumeInfo());
        _installs.Completed += (_, _) => _updateSpace.Poke();
        _life.Token.Register(_updateSpace.Dispose);
        _ = _updateSpace.RunAsync(_life.Token);
        _updateSpace.Poke(); // first look shortly after start (debounced), not on the startup path
        Dispatcher.Register("disk.forecast", _ => Task.FromResult<object?>(_updateSpace.Current()));
    }
}
