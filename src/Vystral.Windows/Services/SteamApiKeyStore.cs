using System.Runtime.InteropServices;
using System.Text;
using System.Text.RegularExpressions;

namespace Vystral.Windows.Services;

/// <summary>Stores small secrets outside the database. The Windows implementation uses Credential Manager.</summary>
public interface ISecretStore
{
    string? Read(string target);
    bool Write(string target, string secret);
    bool Delete(string target);
}

/// <summary>
/// The user's Steam Web API key. It lives only in Windows Credential Manager (generic credential
/// "VYSTRAL/SteamWebApiKey", local-machine persistence for this user) and is never written to
/// SQLite, the log, or a bridge response. The UI only learns whether a key exists and its last
/// four characters.
/// </summary>
public sealed partial class SteamApiKeyStore(ISecretStore store)
{
    public const string Target = "VYSTRAL/SteamWebApiKey";

    /// <summary>Steam Web API keys are 32 hexadecimal characters.</summary>
    public static bool IsValidFormat(string? key) => key is not null && KeyPattern().IsMatch(key);

    /// <summary>Trims surrounding whitespace and upper-cases a pasted key; returns null when it isn't a valid key.</summary>
    public static string? Normalize(string? pasted)
    {
        var k = pasted?.Trim().ToUpperInvariant();
        return IsValidFormat(k) ? k : null;
    }

    public static string Mask(string key) => key.Length >= 4 ? $"••••{key[^4..]}" : "••••";

    /// <summary>The stored key, or null when none is stored or the stored value is malformed.</summary>
    public string? Get()
    {
        var k = store.Read(Target);
        return IsValidFormat(k) ? k : null;
    }

    public bool IsConfigured => Get() is not null;

    public string? MaskedSuffix => Get() is { } k ? Mask(k) : null;

    public bool Set(string key)
    {
        if (!IsValidFormat(key)) throw new ArgumentException("Not a Steam Web API key.", nameof(key));
        return store.Write(Target, key);
    }

    public void Clear() => store.Delete(Target);

    [GeneratedRegex(@"^[0-9A-F]{32}\z")]
    private static partial Regex KeyPattern();
}

/// <summary>Windows Credential Manager (advapi32 CredReadW/CredWriteW/CredDeleteW, generic credentials).</summary>
/// <param name="comment">Shown next to the secret in Credential Manager (defaults to the Steam Web API key text).</param>
public sealed class WindowsCredentialStore(string? comment = null) : ISecretStore
{
    private const uint CredTypeGeneric = 1;
    private const uint CredPersistLocalMachine = 2;
    private const int ErrorNotFound = 1168;

    public string? Read(string target)
    {
        if (!CredRead(target, CredTypeGeneric, 0, out var ptr)) return null;
        try
        {
            var cred = Marshal.PtrToStructure<Credential>(ptr);
            if (cred.CredentialBlob == IntPtr.Zero || cred.CredentialBlobSize == 0 || cred.CredentialBlobSize > 512) return null;
            return Marshal.PtrToStringUni(cred.CredentialBlob, (int)cred.CredentialBlobSize / 2);
        }
        finally
        {
            CredFree(ptr);
        }
    }

    public bool Write(string target, string secret)
    {
        var bytes = Encoding.Unicode.GetBytes(secret);
        var blob = Marshal.AllocHGlobal(bytes.Length);
        try
        {
            Marshal.Copy(bytes, 0, blob, bytes.Length);
            var cred = new Credential
            {
                Type = CredTypeGeneric,
                TargetName = target,
                Comment = comment ?? "Steam Web API key used by VYSTRAL to read your owned games and achievements.",
                CredentialBlobSize = (uint)bytes.Length,
                CredentialBlob = blob,
                Persist = CredPersistLocalMachine,
                UserName = "VYSTRAL",
            };
            return CredWrite(ref cred, 0);
        }
        finally
        {
            // Don't leave the secret lying around in unmanaged memory.
            Marshal.Copy(new byte[bytes.Length], 0, blob, bytes.Length);
            Marshal.FreeHGlobal(blob);
            Array.Clear(bytes);
        }
    }

    public bool Delete(string target) => CredDelete(target, CredTypeGeneric, 0) || Marshal.GetLastWin32Error() == ErrorNotFound;

    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    private struct Credential
    {
        public uint Flags;
        public uint Type;
        public string TargetName;
        public string? Comment;
        public System.Runtime.InteropServices.ComTypes.FILETIME LastWritten;
        public uint CredentialBlobSize;
        public IntPtr CredentialBlob;
        public uint Persist;
        public uint AttributeCount;
        public IntPtr Attributes;
        public string? TargetAlias;
        public string? UserName;
    }

    [DllImport("advapi32.dll", EntryPoint = "CredReadW", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern bool CredRead(string target, uint type, uint reservedFlag, out IntPtr credential);

    [DllImport("advapi32.dll", EntryPoint = "CredWriteW", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern bool CredWrite(ref Credential credential, uint flags);

    [DllImport("advapi32.dll", EntryPoint = "CredDeleteW", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern bool CredDelete(string target, uint type, uint flags);

    [DllImport("advapi32.dll")]
    private static extern void CredFree(IntPtr buffer);
}
