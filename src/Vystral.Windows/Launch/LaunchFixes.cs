using Vystral.Core.Domain;
using Vystral.Windows.Bridge;

namespace Vystral.Windows.Launch;

/// <summary>A one-click fix offered with a failed launch. Id is one of <see cref="LaunchFixes.Ids"/>.</summary>
public sealed record LaunchFixDto(string Id, string Label, string? Platform = null);

/// <summary>
/// What a fix does, decided by VYSTRAL when the launch failed (never by the UI): the URI, the
/// store client exe reported by the adapter, or the game's install folder.
/// </summary>
public sealed record LaunchFixPlan(string Id, PlatformId Platform, Uri? Uri = null, string? ExePath = null, string? Folder = null);

/// <summary>Side effects of fixes, implemented by the backend (and by fakes in tests).</summary>
public interface ILaunchFixRunner
{
    Task RescanPlatformAsync(PlatformId platform);
    void OpenUri(Uri uri);
    void StartClient(string exePath);
    void OpenFolder(string path);
}

public static class LaunchFixes
{
    public const string RescanPlatform = "rescanPlatform";
    public const string OpenStore = "openStore";
    public const string StartClient = "startClient";
    public const string InstallClient = "installClient";
    public const string OpenFolder = "openFolder";

    public static readonly IReadOnlyList<string> Ids = [RescanPlatform, OpenStore, StartClient, InstallClient, OpenFolder];

    /// <summary>Official download pages for each store app (fixed constants; never from the UI).</summary>
    public static Uri? DownloadPage(PlatformId p) => p switch
    {
        PlatformId.Steam => new Uri("https://store.steampowered.com/about/"),
        PlatformId.Epic => new Uri("https://store.epicgames.com/download"),
        PlatformId.Gog => new Uri("https://www.gog.com/galaxy"),
        PlatformId.Ea => new Uri("https://www.ea.com/ea-app"),
        PlatformId.Ubisoft => new Uri("https://www.ubisoft.com/en-us/ubisoft-connect/download"),
        PlatformId.BattleNet => new Uri("https://download.battle.net/desktop"),
        PlatformId.Xbox => new Uri("ms-windows-store://pdp/?ProductId=9MV0B5HZVK9Z"),
        _ => null,
    };

    public static LaunchFixDto ToDto(LaunchFixPlan plan) => new(plan.Id, Label(plan), plan.Platform == PlatformId.Manual ? null : plan.Platform.Key());

    public static string Label(LaunchFixPlan plan) => plan.Id switch
    {
        RescanPlatform => $"Rescan {plan.Platform.DisplayName()}",
        OpenStore => $"Open in {plan.Platform.DisplayName()}",
        StartClient => $"Start {plan.Platform.DisplayName()}",
        InstallClient => $"Get {plan.Platform.DisplayName()}",
        OpenFolder => "Open install folder",
        _ => plan.Id,
    };

    /// <summary>
    /// Runs the fix attached to <paramref name="ticket"/>'s failure. Anything not attached to that
    /// exact failure is refused, so the UI can't use this to open arbitrary links or programs.
    /// Returns a short confirmation for the UI.
    /// </summary>
    public static async Task<string> ExecuteAsync(LaunchFixRegistry registry, string ticket, string actionId, ILaunchFixRunner runner)
    {
        if (!Ids.Contains(actionId)) throw new BridgeException("invalid", "Unknown fix.");
        var plan = registry.Get(ticket, actionId) ?? throw new BridgeException("forbidden", "That fix isn't available for this launch.");
        switch (plan.Id)
        {
            case RescanPlatform:
                await runner.RescanPlatformAsync(plan.Platform);
                return $"Rescanned {plan.Platform.DisplayName()}.";
            case OpenStore:
            case InstallClient:
                if (plan.Uri is null) throw new BridgeException("unsupported", "There's no link for this fix.");
                runner.OpenUri(plan.Uri);
                return plan.Id == OpenStore ? $"Opened {plan.Platform.DisplayName()}." : "Opened the official download page.";
            case StartClient:
                if (plan.ExePath is null || !IsSafeClientExe(plan.ExePath))
                    throw new BridgeException("notFound", $"{plan.Platform.DisplayName()} wasn't found where it was installed.");
                runner.StartClient(plan.ExePath);
                return $"Starting {plan.Platform.DisplayName()}… Try the game again once it's open.";
            case OpenFolder:
                if (plan.Folder is null || !Directory.Exists(plan.Folder)) throw new BridgeException("notFound", "The install folder no longer exists.");
                runner.OpenFolder(plan.Folder);
                return "Opened the install folder.";
            default:
                throw new BridgeException("invalid", "Unknown fix.");
        }
    }

    /// <summary>An absolute local .exe that exists (no UNC/network paths).</summary>
    public static bool IsSafeClientExe(string path) =>
        Path.IsPathFullyQualified(path) && !path.StartsWith(@"\\", StringComparison.Ordinal) &&
        string.Equals(Path.GetExtension(path), ".exe", StringComparison.OrdinalIgnoreCase) && File.Exists(path);
}

/// <summary>Fix plans for the most recent failed launches, keyed by ticket. Bounded.</summary>
public sealed class LaunchFixRegistry
{
    private const int Capacity = 16;
    private readonly Lock _lock = new();
    private readonly LinkedList<(string Ticket, IReadOnlyList<LaunchFixPlan> Plans)> _items = new();

    public void Attach(string ticket, IReadOnlyList<LaunchFixPlan> plans)
    {
        if (plans.Count == 0) return;
        lock (_lock)
        {
            _items.AddFirst((ticket, plans));
            while (_items.Count > Capacity) _items.RemoveLast();
        }
    }

    public LaunchFixPlan? Get(string ticket, string actionId)
    {
        lock (_lock)
        {
            foreach (var (t, plans) in _items)
                if (string.Equals(t, ticket, StringComparison.Ordinal))
                    return plans.FirstOrDefault(p => p.Id == actionId);
        }
        return null;
    }
}
