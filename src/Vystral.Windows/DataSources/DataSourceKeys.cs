using System.Text.RegularExpressions;
using Vystral.Windows.Services;

namespace Vystral.Windows.DataSources;

/// <summary>Providers that need the user's own key or credentials.</summary>
public enum KeyedProvider
{
    SteamGridDb,
    Igdb,
    Rawg,
    IsThereAnyDeal,
}

/// <summary>
/// The user's own keys for opt-in data sources. Each lives only in Windows Credential Manager
/// (generic credentials "VYSTRAL/&lt;Provider&gt;"), never in SQLite, the log, or a bridge
/// response. The UI only learns whether a key exists and its last four characters. IGDB stores
/// the user's own Twitch application's client ID and secret together; the access token they
/// produce is kept in memory only.
/// </summary>
public sealed partial class DataSourceKeyStore(ISecretStore store)
{
    public static string Target(KeyedProvider p) => p switch
    {
        KeyedProvider.SteamGridDb => "VYSTRAL/SteamGridDB",
        KeyedProvider.Igdb => "VYSTRAL/IGDB",
        KeyedProvider.Rawg => "VYSTRAL/RAWG",
        _ => "VYSTRAL/IsThereAnyDeal",
    };

    public static string Comment(KeyedProvider p) => p switch
    {
        KeyedProvider.SteamGridDb => "Your SteamGridDB API key, used by VYSTRAL's artwork picker.",
        KeyedProvider.Igdb => "Your own Twitch application's client ID and secret, used by VYSTRAL to read IGDB game details.",
        KeyedProvider.Rawg => "Your RAWG API key, used by VYSTRAL to read game details.",
        _ => "Your IsThereAnyDeal API key, used by VYSTRAL to show prices.",
    };

    /// <summary>Trims and checks a pasted key; returns null when it can't be a key for that provider.</summary>
    public static string? NormalizeKey(KeyedProvider p, string? pasted)
    {
        var k = pasted?.Trim();
        if (string.IsNullOrEmpty(k)) return null;
        return p switch
        {
            KeyedProvider.Igdb => null, // use NormalizeTwitch
            KeyedProvider.IsThereAnyDeal => ItadKey().IsMatch(k) ? k : null,
            _ => GenericKey().IsMatch(k) ? k : null,
        };
    }

    /// <summary>Twitch client IDs and secrets are lower-case letters and digits (30 today; 16–64 accepted).</summary>
    public static (string ClientId, string Secret)? NormalizeTwitch(string? clientId, string? secret)
    {
        var id = clientId?.Trim().ToLowerInvariant();
        var s = secret?.Trim().ToLowerInvariant();
        return id is not null && s is not null && TwitchPart().IsMatch(id) && TwitchPart().IsMatch(s) && id != s ? (id, s) : null;
    }

    public static string Mask(string key) => key.Length >= 4 ? $"••••{key[^4..]}" : "••••";

    public string? GetKey(KeyedProvider p)
    {
        if (p == KeyedProvider.Igdb) return null;
        var k = store.Read(Target(p));
        return NormalizeKey(p, k) == k ? k : null;
    }

    public (string ClientId, string Secret)? GetTwitch()
    {
        var raw = store.Read(Target(KeyedProvider.Igdb));
        if (raw is null) return null;
        var parts = raw.Split('\n');
        return parts.Length == 2 ? NormalizeTwitch(parts[0], parts[1]) : null;
    }

    public bool IsConfigured(KeyedProvider p) => p == KeyedProvider.Igdb ? GetTwitch() is not null : GetKey(p) is not null;

    /// <summary>The masked suffix shown in Settings (for IGDB, of the client ID; the secret is never shown).</summary>
    public string? Masked(KeyedProvider p) =>
        p == KeyedProvider.Igdb ? GetTwitch() is { } t ? Mask(t.ClientId) : null : GetKey(p) is { } k ? Mask(k) : null;

    public bool SetKey(KeyedProvider p, string key)
    {
        if (p == KeyedProvider.Igdb || NormalizeKey(p, key) != key) throw new ArgumentException("Not a valid key.", nameof(key));
        return store.Write(Target(p), key);
    }

    public bool SetTwitch(string clientId, string secret)
    {
        if (NormalizeTwitch(clientId, secret) is not { } t || t.ClientId != clientId || t.Secret != secret)
            throw new ArgumentException("Not valid Twitch credentials.", nameof(clientId));
        return store.Write(Target(KeyedProvider.Igdb), $"{clientId}\n{secret}");
    }

    public void Clear(KeyedProvider p) => store.Delete(Target(p));

    [GeneratedRegex(@"\A[A-Za-z0-9]{16,64}\z")]
    private static partial Regex GenericKey();

    [GeneratedRegex(@"\A[A-Za-z0-9\-]{16,80}\z")]
    private static partial Regex ItadKey();

    [GeneratedRegex(@"\A[a-z0-9]{16,64}\z")]
    private static partial Regex TwitchPart();
}

/// <summary>Writes each provider's credential with its own Credential Manager comment.</summary>
public sealed class PerTargetCredentialStore(Func<string, ISecretStore> forTarget) : ISecretStore
{
    public string? Read(string target) => forTarget(target).Read(target);
    public bool Write(string target, string secret) => forTarget(target).Write(target, secret);
    public bool Delete(string target) => forTarget(target).Delete(target);
}
