using System.Net;
using System.Net.Sockets;

namespace Vystral.Windows.Services;

/// <summary>
/// Connects the way browsers do ("happy eyeballs"): every address a host resolves to is tried,
/// a new attempt starts every 250 ms while earlier ones are still pending, and the first socket
/// that connects wins. .NET's default tries one address at a time and waits out the full TCP
/// timeout (about 21 s on Windows) on any that's unreachable, so a single bad CDN address, such
/// as one of GitHub's release-download hosts, made update checks take minutes or time out.
/// </summary>
public static class FastConnect
{
    public static readonly TimeSpan AttemptDelay = TimeSpan.FromMilliseconds(250);

    /// <summary>A handler with the fast connector and sensible defaults for VYSTRAL's web requests.</summary>
    public static SocketsHttpHandler CreateHandler(bool allowRedirects = true) => new()
    {
        ConnectCallback = ConnectAsync,
        ConnectTimeout = TimeSpan.FromSeconds(15),
        AllowAutoRedirect = allowRedirects,
        AutomaticDecompression = DecompressionMethods.All,
        PooledConnectionLifetime = TimeSpan.FromMinutes(5),
    };

    public static async ValueTask<Stream> ConnectAsync(SocketsHttpConnectionContext context, CancellationToken ct)
    {
        var host = context.DnsEndPoint.Host;
        var port = context.DnsEndPoint.Port;
        var addresses = IPAddress.TryParse(host, out var literal) ? [literal] : await Dns.GetHostAddressesAsync(host, ct).ConfigureAwait(false);
        var socket = await ConnectFirstAsync(Interleave(addresses), port, ct).ConfigureAwait(false);
        return new NetworkStream(socket, ownsSocket: true);
    }

    /// <summary>Alternates address families (IPv6, IPv4, IPv6…) so one broken family can't stall the rest.</summary>
    internal static IReadOnlyList<IPAddress> Interleave(IReadOnlyList<IPAddress> addresses)
    {
        var v6 = new Queue<IPAddress>(addresses.Where(a => a.AddressFamily == AddressFamily.InterNetworkV6));
        var v4 = new Queue<IPAddress>(addresses.Where(a => a.AddressFamily == AddressFamily.InterNetwork));
        var first = addresses.Count > 0 && addresses[0].AddressFamily == AddressFamily.InterNetwork ? v4 : v6;
        var second = ReferenceEquals(first, v4) ? v6 : v4;
        var result = new List<IPAddress>(addresses.Count);
        while (first.Count > 0 || second.Count > 0)
        {
            if (first.Count > 0) result.Add(first.Dequeue());
            if (second.Count > 0) result.Add(second.Dequeue());
        }
        return result;
    }

    /// <summary>Staggered parallel connects; returns the first connected socket and closes any later winners.</summary>
    internal static async Task<Socket> ConnectFirstAsync(IReadOnlyList<IPAddress> addresses, int port, CancellationToken ct,
        Func<IPAddress, int, CancellationToken, Task<Socket>>? connectOne = null, TimeSpan? attemptDelay = null)
    {
        if (addresses.Count == 0) throw new SocketException((int)SocketError.HostNotFound);
        connectOne ??= ConnectOneAsync;
        var stagger = attemptDelay ?? AttemptDelay;
        using var losers = CancellationTokenSource.CreateLinkedTokenSource(ct);
        var pending = new List<Task<Socket>>();
        Exception? lastError = null;
        var next = 0;
        while (true)
        {
            ct.ThrowIfCancellationRequested();
            if (next < addresses.Count) pending.Add(connectOne(addresses[next++], port, losers.Token));
            if (pending.Count == 0) throw lastError ?? new SocketException((int)SocketError.HostUnreachable);

            Task finished = next < addresses.Count
                ? await Task.WhenAny([.. pending, Task.Delay(stagger, ct)]).ConfigureAwait(false)
                : await Task.WhenAny(pending).ConfigureAwait(false);
            if (finished is not Task<Socket> attempt) continue; // stagger elapsed: start the next address

            pending.Remove(attempt);
            if (attempt.IsCompletedSuccessfully)
            {
                losers.Cancel();
                foreach (var other in pending)
                    _ = other.ContinueWith(t => { if (t.IsCompletedSuccessfully) t.Result.Dispose(); }, TaskScheduler.Default);
                return attempt.Result;
            }
            ct.ThrowIfCancellationRequested();
            lastError = attempt.Exception?.GetBaseException() ?? lastError;
        }
    }

    private static async Task<Socket> ConnectOneAsync(IPAddress address, int port, CancellationToken ct)
    {
        var socket = new Socket(address.AddressFamily, SocketType.Stream, ProtocolType.Tcp) { NoDelay = true };
        try
        {
            await socket.ConnectAsync(new IPEndPoint(address, port), ct).ConfigureAwait(false);
            return socket;
        }
        catch
        {
            socket.Dispose();
            throw;
        }
    }
}
