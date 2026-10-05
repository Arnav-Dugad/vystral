using System.Diagnostics;
using System.Net;
using System.Net.Sockets;
using Vystral.Windows.Services;
using Xunit;

namespace Vystral.Tests.Services;

public sealed class FastConnectTests
{
    private static readonly IPAddress Bad = IPAddress.Parse("185.199.109.133");
    private static readonly IPAddress Good = IPAddress.Parse("185.199.108.133");

    /// <summary>A fake connector: listed addresses "hang" (until cancelled) or fail; anything else connects.</summary>
    private static Func<IPAddress, int, CancellationToken, Task<Socket>> Fake(HashSet<IPAddress>? hang = null, HashSet<IPAddress>? fail = null, List<IPAddress>? tried = null) =>
        async (address, _, ct) =>
        {
            lock (tried ?? []) tried?.Add(address);
            if (hang?.Contains(address) == true) await Task.Delay(Timeout.Infinite, ct);
            if (fail?.Contains(address) == true) throw new SocketException((int)SocketError.ConnectionRefused);
            await Task.Delay(10, ct);
            return new Socket(address.AddressFamily, SocketType.Stream, ProtocolType.Tcp);
        };

    [Fact]
    public async Task An_unreachable_first_address_costs_one_stagger_not_a_tcp_timeout()
    {
        var sw = Stopwatch.StartNew();
        using var socket = await FastConnect.ConnectFirstAsync([Bad, Good], 443, TestContext.Current.CancellationToken,
            Fake(hang: [Bad]), TimeSpan.FromMilliseconds(100));
        Assert.True(sw.ElapsedMilliseconds < 2000, $"took {sw.ElapsedMilliseconds} ms");
    }

    [Fact]
    public async Task A_refused_address_moves_on_immediately()
    {
        var tried = new List<IPAddress>();
        var sw = Stopwatch.StartNew();
        using var socket = await FastConnect.ConnectFirstAsync([Bad, Good], 443, TestContext.Current.CancellationToken,
            Fake(fail: [Bad], tried: tried), TimeSpan.FromSeconds(5));
        Assert.Equal([Bad, Good], tried);
        Assert.True(sw.ElapsedMilliseconds < 2000, $"took {sw.ElapsedMilliseconds} ms");
    }

    [Fact]
    public async Task When_every_address_fails_the_last_error_is_thrown() =>
        await Assert.ThrowsAsync<SocketException>(() => FastConnect.ConnectFirstAsync([Bad, Good], 443, TestContext.Current.CancellationToken,
            Fake(fail: [Bad, Good]), TimeSpan.FromMilliseconds(50)));

    [Fact]
    public async Task Cancellation_stops_hanging_attempts()
    {
        using var cts = new CancellationTokenSource(TimeSpan.FromMilliseconds(200));
        await Assert.ThrowsAnyAsync<OperationCanceledException>(() => FastConnect.ConnectFirstAsync([Bad, Good], 443, cts.Token,
            Fake(hang: [Bad, Good]), TimeSpan.FromMilliseconds(50)));
    }

    [Fact]
    public async Task No_addresses_is_host_not_found()
    {
        var ex = await Assert.ThrowsAsync<SocketException>(() => FastConnect.ConnectFirstAsync([], 443, TestContext.Current.CancellationToken, Fake()));
        Assert.Equal(SocketError.HostNotFound, ex.SocketErrorCode);
    }

    [Fact]
    public void Address_families_alternate_starting_with_the_first_resolved()
    {
        var v6a = IPAddress.Parse("2001:db8::1");
        var v6b = IPAddress.Parse("2001:db8::2");
        var v4a = IPAddress.Parse("192.0.2.1");
        var v4b = IPAddress.Parse("192.0.2.2");
        Assert.Equal([v6a, v4a, v6b, v4b], FastConnect.Interleave([v6a, v6b, v4a, v4b]));
        Assert.Equal([v4a, v6a, v4b], FastConnect.Interleave([v4a, v4b, v6a]));
    }

    [Fact]
    public async Task Real_handler_connects_to_a_local_listener()
    {
        using var listener = new TcpListener(IPAddress.Loopback, 0);
        listener.Start();
        var port = ((IPEndPoint)listener.LocalEndpoint).Port;
        var accept = listener.AcceptSocketAsync(TestContext.Current.CancellationToken);
        using var socket = await FastConnect.ConnectFirstAsync([IPAddress.Loopback], port, TestContext.Current.CancellationToken);
        Assert.True(socket.Connected);
        (await accept).Dispose();
    }
}
