using Vystral.Core.Integrations;
using Vystral.Windows.Integrations;

namespace Vystral.Windows.Services;

/// <summary>The set of built-in platform integrations, in display order.</summary>
public static class AdapterCatalog
{
    public static IReadOnlyList<IPlatformAdapter> Create(IRegistryReader registry, AdapterEnvironment env, SteamAdapter steam) =>
    [
        steam,
        new XboxAdapter(registry),
        new EpicAdapter(registry, env),
        new GogAdapter(registry),
        new EaAdapter(registry, env),
        new UbisoftAdapter(registry),
        new BattleNetAdapter(registry, env),
    ];
}
