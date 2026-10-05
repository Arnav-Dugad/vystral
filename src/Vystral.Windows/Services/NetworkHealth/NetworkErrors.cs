using System.Net;
using System.Net.Http;
using System.Net.Sockets;
using System.Security.Authentication;

namespace Vystral.Windows.Services.NetworkHealth;

/// <summary>A network failure in plain words, plus a short machine-readable kind.</summary>
public sealed record NetworkFailure(string Kind, string Text, int? Status = null);

/// <summary>
/// Turns .NET's network exceptions into the actual reason, in words people understand
/// ("DNS failed", "TLS error", "timed out"). Shared by the update checker and Network health.
/// </summary>
public static class NetworkErrors
{
    public static NetworkFailure Describe(Exception ex)
    {
        for (var e = ex; e is not null; e = e.InnerException)
        {
            switch (e)
            {
                case TimeoutException:
                case TaskCanceledException { InnerException: TimeoutException }:
                    return new("timeout", "Timed out: the server didn't answer in time");
                case AuthenticationException:
                    return Tls;
                case SocketException se:
                    return FromSocket(se.SocketErrorCode);
                case HttpRequestException hre:
                    if (hre.StatusCode is { } status) return FromStatus((int)status);
                    switch (hre.HttpRequestError)
                    {
                        case HttpRequestError.NameResolutionError: return Dns;
                        case HttpRequestError.SecureConnectionError: return Tls;
                        case HttpRequestError.ProxyTunnelError: return new("proxy", "The proxy server refused the connection");
                        case HttpRequestError.ConnectionError when e.InnerException is null:
                            return new("connect", "Couldn't connect to the server");
                    }
                    break;
            }
        }
        if (ex is OperationCanceledException) return new("timeout", "Timed out: the server didn't answer in time");
        return new("other", "The connection failed");
    }

    public static NetworkFailure FromStatus(int status) => status switch
    {
        429 => new("rateLimited", "Rate limited (HTTP 429)", status),
        403 => new("forbidden", "Refused (HTTP 403), often a rate limit", status),
        404 => new("notFound", "Not found (HTTP 404)", status),
        >= 500 => new("server", $"The service has a problem (HTTP {status})", status),
        _ => new("http", $"Unexpected answer (HTTP {status})", status),
    };

    private static readonly NetworkFailure Dns = new("dns", "DNS failed: the address couldn't be looked up");
    private static readonly NetworkFailure Tls = new("tls", "TLS error: the secure connection couldn't be verified (a proxy, antivirus or a wrong clock can cause this)");

    private static NetworkFailure FromSocket(SocketError code) => code switch
    {
        SocketError.HostNotFound or SocketError.NoData or SocketError.TryAgain => Dns,
        SocketError.TimedOut => new("timeout", "Timed out: no answer from the server"),
        SocketError.ConnectionRefused => new("refused", "The server refused the connection"),
        SocketError.NetworkUnreachable or SocketError.HostUnreachable or SocketError.NetworkDown => new("unreachable", "Not reachable from this network"),
        SocketError.ConnectionReset or SocketError.ConnectionAborted => new("reset", "The connection was cut off"),
        SocketError.AccessDenied => new("blocked", "Blocked by a firewall or security software"),
        _ => new("connect", $"Couldn't connect ({code})"),
    };

    /// <summary>"12 min", "40 s", "2 h": how long until a rate limit resets.</summary>
    public static string Duration(TimeSpan t) =>
        t.TotalSeconds < 60 ? $"{Math.Max(1, (int)Math.Ceiling(t.TotalSeconds))} s" :
        t.TotalMinutes < 120 ? $"{(int)Math.Ceiling(t.TotalMinutes)} min" : $"{(int)Math.Round(t.TotalHours)} h";

    internal static bool IsIpv6(IPAddress a) => a.AddressFamily == AddressFamily.InterNetworkV6;
}
