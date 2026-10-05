namespace Vystral.Core.Domain;

/// <summary>
/// Values of <c>sessions.source</c>. Every source except <see cref="Imported"/> is a session VYSTRAL
/// observed itself; they only differ in how it noticed the game, and are counted the same everywhere.
/// </summary>
public static class SessionSources
{
    /// <summary>Started from VYSTRAL and observed by it.</summary>
    public const string Tracked = "tracked";

    /// <summary>Started outside VYSTRAL (a store client, a shortcut) and noticed while VYSTRAL was open.</summary>
    public const string Detected = "detected";

    /// <summary>Noticed by the background tracker while VYSTRAL was closed.</summary>
    public const string Background = "background";

    /// <summary>Read from a store (never mixed with observed time).</summary>
    public const string Imported = "imported";

    /// <summary>SQL list for <c>source IN …</c>: every source VYSTRAL observed itself.</summary>
    public const string ObservedSql = "('tracked','detected','background')";

    public static bool IsObserved(string? source) => source is Tracked or Detected or Background;
}
