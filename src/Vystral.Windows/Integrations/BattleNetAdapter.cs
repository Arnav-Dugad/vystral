using System.Text.RegularExpressions;
using Vystral.Core.Domain;
using Vystral.Core.Integrations;

namespace Vystral.Windows.Integrations;

/// <summary>
/// Finds Battle.net games from their "Apps &amp; features" entries (Blizzard's uninstaller is called
/// with --uid=&lt;product uid&gt;) and starts them with the documented client switch
/// Battle.net.exe --exec="launch &lt;CODE&gt;".
/// </summary>
public sealed partial class BattleNetAdapter(IRegistryReader registry, AdapterEnvironment? environment = null) : IPlatformAdapter
{
    /// <summary>Install uid prefix → Battle.net product code (from Playnite's BattleNetGames table).</summary>
    internal static readonly IReadOnlyList<(string UidPrefix, string Code)> Products =
    [
        ("wow", "WoW"), ("diablo3", "D3"), ("s2", "S2"), ("s1", "S1"), ("hs_beta", "WTCG"), ("heroes", "Hero"),
        ("prometheus", "Pro"), ("viper", "VIPR"), ("odin", "ODIN"), ("w3", "W3"), ("lazarus", "LAZR"),
        ("zeus", "ZEUS"), ("wlby", "WLBY"), ("osi", "OSI"), ("rtro", "RTRO"), ("fore", "FORE"), ("anbs", "ANBS"),
        ("auks", "AUKS"), ("fen", "Fen"), ("d1", "D1"), ("w1r", "W1R"), ("w2r", "W2R"), ("w1", "W1"), ("w2", "W2"),
        ("gryphon", "GRY"), ("aris", "ARIS"), ("scorpio", "SCOR"), ("arkansas", "ARK"), ("libra", "LBRA"),
        ("pinta", "PNTA"), ("aqua", "AQUA"),
    ];

    [GeneratedRegex(@"Battle\.net.*--uid=([^\s""]+)", RegexOptions.IgnoreCase | RegexOptions.CultureInvariant)]
    private static partial Regex UidRegex();

    public PlatformId Platform => PlatformId.BattleNet;

    public AdapterCapabilities Capabilities => AdapterCapabilities.DiscoverInstalled | AdapterCapabilities.Launch;

    public IReadOnlyList<string> Limitations =>
    [
        "Shows Battle.net games installed on this PC that VYSTRAL recognizes. Newly released games may not be recognized until VYSTRAL is updated.",
        "Playtime isn't available locally for Battle.net games; VYSTRAL tracks sessions you start from here.",
        "Games start through the Battle.net app, which opens first and may ask you to sign in.",
        "Classic games such as Diablo II and Warcraft III (original) aren't detected.",
    ];

    public string? FindClientExe()
    {
        foreach (var entry in UninstallScanner.Read(registry))
        {
            if (entry.UninstallString?.Contains("-uid=battle.net", StringComparison.OrdinalIgnoreCase) == true && entry.InstallLocation is not null)
            {
                var exe = Path.Combine(entry.InstallLocation, "Battle.net.exe");
                if (AdapterIo.FileExists(exe)) return exe;
            }
        }
        if (environment is not null)
        {
            var fallback = Path.Combine(environment.ProgramFilesX86, "Battle.net", "Battle.net.exe");
            if (AdapterIo.FileExists(fallback)) return fallback;
        }
        return null;
    }

    public AdapterStatus GetStatus()
    {
        var exe = FindClientExe();
        return exe is not null
            ? new AdapterStatus(ClientStatus.Available, exe)
            : new AdapterStatus(ClientStatus.NotInstalled, null);
    }

    public Task<IReadOnlyList<DiscoveredInstallation>> DiscoverAsync(CancellationToken cancellationToken) =>
        Task.FromResult(Discover(cancellationToken));

    internal IReadOnlyList<DiscoveredInstallation> Discover(CancellationToken ct)
    {
        var client = FindClientExe();
        // Without the client there is no supported way to start these games.
        if (client is null) return [];

        var results = new List<DiscoveredInstallation>();
        var seenCodes = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
        var seenPaths = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
        foreach (var entry in UninstallScanner.Read(registry))
        {
            ct.ThrowIfCancellationRequested();
            if (entry.UninstallString is null || entry.InstallLocation is null) continue;
            var match = UidRegex().Match(entry.UninstallString);
            if (!match.Success) continue;
            var uid = match.Groups[1].Value;
            if (uid.Equals("battle.net", StringComparison.OrdinalIgnoreCase)) continue;
            if (entry.DisplayName is { } dn && (dn.EndsWith("Test", StringComparison.OrdinalIgnoreCase) || dn.EndsWith("Beta", StringComparison.OrdinalIgnoreCase)))
                continue;

            var code = MapUid(uid);
            if (code is null) continue;
            var dir = AdapterIo.PathKey(entry.InstallLocation);
            if (dir is null || !AdapterIo.DirectoryExists(dir)) continue;
            if (!seenCodes.Add(code) || !seenPaths.Add(dir)) continue;

            var title = entry.DisplayName ?? Path.GetFileName(dir);
            if (string.IsNullOrWhiteSpace(title)) continue;
            results.Add(new DiscoveredInstallation
            {
                Platform = PlatformId.BattleNet,
                PlatformGameId = code,
                Title = title.Trim(),
                InstallPath = dir,
                Launch = new LaunchTarget(LaunchKind.Executable, client, $"--exec=\"launch {code}\"", Path.GetDirectoryName(client)),
                ClientRequired = true,
            });
        }
        return results;
    }

    /// <summary>Maps an install uid such as "prometheus" or "wow_beta" to its product code; longest prefix wins.</summary>
    internal static string? MapUid(string uid) =>
        Products.Where(p => uid.StartsWith(p.UidPrefix, StringComparison.OrdinalIgnoreCase))
            .OrderByDescending(p => p.UidPrefix.Length)
            .Select(p => p.Code)
            .FirstOrDefault();
}
