namespace Vystral.Windows.Services;

/// <summary>
/// Whole-request time limits. <see cref="HttpClient.Timeout"/> only covers a request until its headers
/// arrive when it is sent with <see cref="HttpCompletionOption.ResponseHeadersRead"/>; a server that then
/// trickles (or stalls) the body would otherwise hold the request, and the provider lane or download slot
/// it occupies, forever. Each streamed request links one of these limits into its token for sending
/// <i>and</i> reading the body.
/// </summary>
internal static class RequestTimeouts
{
    /// <summary>JSON and other small API answers.</summary>
    public static readonly TimeSpan Json = TimeSpan.FromSeconds(30);

    /// <summary>Images, video segments and other media files.</summary>
    public static readonly TimeSpan Media = TimeSpan.FromSeconds(60);

    /// <summary>A token source cancelled by <paramref name="ct"/> or after <paramref name="limit"/>. Dispose it after the body was read.</summary>
    public static CancellationTokenSource Link(CancellationToken ct, TimeSpan limit)
    {
        var cts = CancellationTokenSource.CreateLinkedTokenSource(ct);
        cts.CancelAfter(limit);
        return cts;
    }
}
