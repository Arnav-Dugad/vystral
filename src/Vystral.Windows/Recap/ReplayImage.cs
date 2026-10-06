using System.Buffers.Binary;
using System.Security.Cryptography;
using Vystral.Windows.Bridge;

namespace Vystral.Windows.Recap;

/// <summary>
/// Receives a replay card the page rendered (a 1920×1080 PNG) in base64 chunks, because one bridge message is
/// capped at 256 K characters. Each upload is bound to a session, expires after two minutes, must arrive in
/// order and is checked to be exactly a PNG of the expected size before VYSTRAL saves or copies it. The page
/// never chooses a path: saving always goes through the native save dialog.
/// </summary>
public sealed class ReplayImageStore(Func<DateTimeOffset>? clock = null)
{
    public const int Width = 1920;
    public const int Height = 1080;
    public const int MaxBytes = 20 * 1024 * 1024;
    public const int MaxChunkChars = 192 * 1024;
    public const int MaxUploads = 2;
    public static readonly TimeSpan Ttl = TimeSpan.FromMinutes(2);

    private static readonly byte[] Signature = [0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A];
    private static readonly byte[] IendTail = [0, 0, 0, 0, 0x49, 0x45, 0x4E, 0x44, 0xAE, 0x42, 0x60, 0x82];

    private sealed class Upload(string sessionId, int total, DateTimeOffset started)
    {
        public string SessionId { get; } = sessionId;
        public byte[] Buffer { get; } = new byte[total];
        public int Received { get; set; }
        public int NextIndex { get; set; }
        public DateTimeOffset Started { get; } = started;
    }

    private readonly Func<DateTimeOffset> _now = clock ?? (() => DateTimeOffset.UtcNow);
    private readonly Dictionary<string, Upload> _uploads = new(StringComparer.Ordinal);
    private readonly Lock _lock = new();

    /// <summary>Starts an upload of <paramref name="totalBytes"/> bytes for a session. Returns its token.</summary>
    public string Begin(string sessionId, int totalBytes)
    {
        if (totalBytes is < 64 or > MaxBytes) throw new BridgeException("invalid", "That image is too large to save.");
        lock (_lock)
        {
            Sweep();
            while (_uploads.Count >= MaxUploads)
                _uploads.Remove(_uploads.MinBy(u => u.Value.Started).Key);
            var token = Convert.ToHexStringLower(RandomNumberGenerator.GetBytes(16));
            _uploads[token] = new Upload(sessionId, totalBytes, _now());
            return token;
        }
    }

    /// <summary>Adds the next base64 chunk. Chunks must arrive in order (index 0, 1, 2, …).</summary>
    public int Append(string token, int index, string base64)
    {
        if (base64.Length is 0 or > MaxChunkChars) throw new BridgeException("invalid", "Invalid image chunk.");
        byte[] bytes;
        try { bytes = Convert.FromBase64String(base64); }
        catch (FormatException) { throw new BridgeException("invalid", "Invalid image chunk."); }
        lock (_lock)
        {
            var u = Get(token);
            if (index != u.NextIndex) throw new BridgeException("invalid", "Image chunks arrived out of order.");
            if (u.Received + bytes.Length > u.Buffer.Length)
            {
                _uploads.Remove(token);
                throw new BridgeException("invalid", "The image is larger than announced.");
            }
            bytes.CopyTo(u.Buffer, u.Received);
            u.Received += bytes.Length;
            u.NextIndex++;
            return u.Received;
        }
    }

    /// <summary>Completes an upload: returns the PNG and the session it belongs to, after validating it. The upload is consumed.</summary>
    public (string SessionId, byte[] Png) Take(string token)
    {
        lock (_lock)
        {
            var u = Get(token);
            _uploads.Remove(token);
            if (u.Received != u.Buffer.Length) throw new BridgeException("invalid", "The image didn't arrive completely. Try again.");
            if (!IsExpectedPng(u.Buffer)) throw new BridgeException("invalid", "That isn't a 1920×1080 PNG image.");
            return (u.SessionId, u.Buffer);
        }
    }

    /// <summary>A PNG signature, an IHDR of exactly 1920×1080, and an IEND chunk at the very end.</summary>
    public static bool IsExpectedPng(ReadOnlySpan<byte> png, int width = Width, int height = Height) =>
        png.Length > 8 + 25 + IendTail.Length &&
        png[..8].SequenceEqual(Signature) &&
        BinaryPrimitives.ReadUInt32BigEndian(png[8..12]) == 13 &&
        png[12..16].SequenceEqual("IHDR"u8) &&
        BinaryPrimitives.ReadUInt32BigEndian(png[16..20]) == (uint)width &&
        BinaryPrimitives.ReadUInt32BigEndian(png[20..24]) == (uint)height &&
        png[^IendTail.Length..].SequenceEqual(IendTail);

    public int Pending
    {
        get { lock (_lock) { Sweep(); return _uploads.Count; } }
    }

    private Upload Get(string token)
    {
        Sweep();
        return _uploads.TryGetValue(token, out var u) ? u : throw new BridgeException("notFound", "That image upload expired. Try again.");
    }

    private void Sweep()
    {
        var now = _now();
        foreach (var key in _uploads.Where(kv => now - kv.Value.Started > Ttl).Select(kv => kv.Key).ToList()) _uploads.Remove(key);
    }

    /// <summary>A safe default file name built natively from the game title and session date (never from the page).</summary>
    public static string SuggestedName(string title, DateTimeOffset start)
    {
        var invalid = Path.GetInvalidFileNameChars();
        var clean = new string(title.Where(c => !invalid.Contains(c) && !char.IsControl(c)).ToArray()).Trim().TrimEnd('.');
        if (clean.Length > 60) clean = clean[..60].TrimEnd();
        if (clean.Length == 0) clean = "Session";
        return $"VYSTRAL replay - {clean} - {start.ToLocalTime():yyyy-MM-dd}";
    }
}
