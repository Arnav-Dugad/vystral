using Vystral.Core.Domain;

namespace Vystral.Core.Integrations;

public enum ClientStatus
{
    /// <summary>The store client is installed and its data could be read.</summary>
    Available,
    /// <summary>The store client is not installed on this PC.</summary>
    NotInstalled,
    /// <summary>The client is present but its data could not be read (permissions, corrupt file, unknown format).</summary>
    Error,
}

public sealed record AdapterStatus(ClientStatus Status, string? ClientPath, string? Detail = null);

public sealed record AdapterScanResult(
    PlatformId Platform,
    bool Succeeded,
    IReadOnlyList<DiscoveredInstallation> Installations,
    string? Error = null,
    TimeSpan Elapsed = default);

/// <summary>
/// One storefront integration. Adapters are read-only: they inspect documented local
/// manifests/registry data and produce launch targets for supported launch mechanisms.
/// They must never write to platform files, read credentials, or contact private endpoints.
/// </summary>
public interface IPlatformAdapter
{
    PlatformId Platform { get; }
    AdapterCapabilities Capabilities { get; }

    /// <summary>Plain-language limitations shown to the user next to this integration.</summary>
    IReadOnlyList<string> Limitations { get; }

    AdapterStatus GetStatus();

    Task<IReadOnlyList<DiscoveredInstallation>> DiscoverAsync(CancellationToken cancellationToken);

    /// <summary>A URI that opens the game's page in the platform client, or null if unsupported.</summary>
    string? GetClientPageUri(string platformGameId) => null;
}
