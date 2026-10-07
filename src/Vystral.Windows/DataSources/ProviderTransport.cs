using System.Net;
using Vystral.Windows.Services;

namespace Vystral.Windows.DataSources;

public enum DataSourceOutcome
{
    Ok,
    /// <summary>The provider rejected the key or credentials.</summary>
    InvalidKey,
    /// <summary>No key is stored for a provider that needs one.</summary>
    NotConfigured,
    /// <summary>The provider asked VYSTRAL to slow down (429), or a local pause is still running.</summary>
    RateLimited,
    /// <summary>Network trouble or a provider server error.</summary>
    Unavailable,
    /// <summary>The provider answered with something VYSTRAL couldn't read.</summary>
    Malformed,
    /// <summary>Offline mode is on (nothing is sent).</summary>
    Offline,
    /// <summary>The source is turned off in Settings.</summary>
    Disabled,
}

/// <summary>An expected provider failure. Messages never contain keys, tokens or request URLs.</summary>
public sealed class DataSourceException(DataSourceOutcome outcome, string message) : Exception(message)
{
    public DataSourceOutcome Outcome { get; } = outcome;
}

/// <param name="Location">The redirect target, when a lane uses a client that doesn't follow redirects (Track X: PCGamingWiki).</param>
public sealed record ProviderResponse(HttpStatusCode Status, string Body, string? ETag, Uri? Location = null);

/// <summary>
/// One polite HTTP lane per provider: requests are serialized and spaced at least
/// <see cref="MinSpacing"/> apart, a 429 pauses the provider for its Retry-After (5 s – 1 h),
/// answers are size-capped, and only the provider name and URL path (never the query, which may
/// hold a key) are ever logged.
/// </summary>
public sealed class ProviderTransport(HttpClient http, string provider, string displayName, TimeSpan minSpacing, int maxBytes = 4 * 1024 * 1024)
{
    private readonly SemaphoreSlim _gate = new(1, 1);
    private DateTime _next = DateTime.MinValue;
    private DateTime _blockedUntil = DateTime.MinValue;

    public string Provider { get; } = provider;
    public string DisplayName { get; } = displayName;
    public TimeSpan MinSpacing { get; } = minSpacing;

    /// <summary>When the provider last asked for a pause, until when (UTC); null when not paused.</summary>
    public DateTimeOffset? BlockedUntil => _blockedUntil > DateTime.UtcNow ? new DateTimeOffset(_blockedUntil, TimeSpan.Zero) : null;

    /// <summary>Limit for one request, body included (tests shorten it).</summary>
    internal TimeSpan RequestTimeout { get; set; } = Services.RequestTimeouts.Json;

    /// <summary>Test hook: replaces the real delay.</summary>
    internal Func<TimeSpan, CancellationToken, Task> Delay { get; set; } = Task.Delay;

    public async Task<ProviderResponse> SendAsync(Func<HttpRequestMessage> build, CancellationToken ct)
    {
        await _gate.WaitAsync(ct);
        try
        {
            var now = DateTime.UtcNow;
            if (_blockedUntil > now)
                throw new DataSourceException(DataSourceOutcome.RateLimited, $"{DisplayName} asked VYSTRAL to slow down. Try again in a little while.");
            if (_next > now) await Delay(_next - now, ct);
            _next = DateTime.UtcNow + MinSpacing;

            using var request = build();
            var path = request.RequestUri?.AbsolutePath ?? "";
            if (request.RequestUri is not { Scheme: "https" })
                throw new DataSourceException(DataSourceOutcome.Malformed, "VYSTRAL only talks to data sources over HTTPS.");
            // One limit for sending and reading the body (HttpClient.Timeout stops at the headers here).
            using var timeout = Services.RequestTimeouts.Link(ct, RequestTimeout);
            HttpResponseMessage response;
            try
            {
                response = await http.SendAsync(request, HttpCompletionOption.ResponseHeadersRead, timeout.Token);
            }
            catch (Exception ex) when (ex is HttpRequestException or OperationCanceledException && !ct.IsCancellationRequested)
            {
                Log.Warn("datasource", "Request failed", new { provider = Provider, path, error = ex.GetType().Name });
                throw new DataSourceException(DataSourceOutcome.Unavailable, $"VYSTRAL couldn’t reach {DisplayName}. Check your connection and try again.");
            }
            using (response)
            {
                if (response.StatusCode == HttpStatusCode.TooManyRequests)
                {
                    var wait = response.Headers.RetryAfter?.Delta
                               ?? (response.Headers.RetryAfter?.Date is { } at ? at - DateTimeOffset.UtcNow : (TimeSpan?)null)
                               ?? TimeSpan.FromMinutes(1);
                    _blockedUntil = DateTime.UtcNow + Clamp(wait);
                    Log.Warn("datasource", "Rate limited", new { provider = Provider, path, seconds = (int)Clamp(wait).TotalSeconds });
                    throw new DataSourceException(DataSourceOutcome.RateLimited, $"{DisplayName} asked VYSTRAL to slow down. Try again in a little while.");
                }
                if (response.Content.Headers.ContentLength > maxBytes)
                    throw new DataSourceException(DataSourceOutcome.Malformed, $"{DisplayName} sent an unexpectedly large answer.");
                string? body;
                try { body = await ReadCappedAsync(response.Content, maxBytes, timeout.Token); }
                catch (Exception ex) when (ex is HttpRequestException or IOException or OperationCanceledException && !ct.IsCancellationRequested)
                {
                    Log.Warn("datasource", "Reading the answer failed", new { provider = Provider, path, error = ex.GetType().Name });
                    throw new DataSourceException(DataSourceOutcome.Unavailable, $"{DisplayName} stopped answering. Check your connection and try again.");
                }
                if (body is null)
                    throw new DataSourceException(DataSourceOutcome.Malformed, $"{DisplayName} sent an unexpectedly large answer.");
                if ((int)response.StatusCode >= 500)
                {
                    Log.Warn("datasource", "Server error", new { provider = Provider, path, status = (int)response.StatusCode });
                    throw new DataSourceException(DataSourceOutcome.Unavailable, $"{DisplayName} is having trouble right now. Try again later.");
                }
                return new ProviderResponse(response.StatusCode, body, response.Headers.ETag?.Tag, response.Headers.Location);
            }
        }
        finally
        {
            _gate.Release();
        }
    }

    /// <summary>Clears a pause (used after the user changes the key).</summary>
    public void ResetPause() => _blockedUntil = DateTime.MinValue;

    internal static TimeSpan Clamp(TimeSpan wait) =>
        wait < TimeSpan.FromSeconds(5) ? TimeSpan.FromSeconds(5) : wait > TimeSpan.FromHours(1) ? TimeSpan.FromHours(1) : wait;

    private static async Task<string?> ReadCappedAsync(HttpContent content, int maxBytes, CancellationToken ct)
    {
        await using var stream = await content.ReadAsStreamAsync(ct);
        using var buffer = new MemoryStream();
        var chunk = new byte[32768];
        int read;
        while ((read = await stream.ReadAsync(chunk, ct)) > 0)
        {
            buffer.Write(chunk, 0, read);
            if (buffer.Length > maxBytes) return null;
        }
        return System.Text.Encoding.UTF8.GetString(buffer.GetBuffer(), 0, (int)buffer.Length);
    }
}
