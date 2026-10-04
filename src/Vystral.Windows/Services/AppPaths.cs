namespace Vystral.Windows.Services;

/// <summary>
/// All locations VYSTRAL writes to. Data lives outside the install folder because the updater
/// replaces the install folder on every update, and uninstalling must not delete user data.
/// </summary>
public sealed class AppPaths
{
    public string Root { get; }
    public string Database => Path.Combine(Root, "vystral.db");
    public string Backups => Path.Combine(Root, "backups");
    public string Logs => Path.Combine(Root, "logs");
    public string ArtCache => Path.Combine(Root, "cache", "art");
    public string ThumbCache => Path.Combine(Root, "cache", "thumbs");
    public string WebViewData => Path.Combine(Root, "webview");
    public string SafeModeFlag => Path.Combine(Root, "safe-mode.flag");
    public string CrashMarker => Path.Combine(Root, "running.marker");

    public AppPaths(string? root = null)
    {
        Root = root ?? Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "VYSTRAL.Data");
        foreach (var dir in new[] { Root, Backups, Logs, ArtCache, ThumbCache, WebViewData }) Directory.CreateDirectory(dir);
    }
}
