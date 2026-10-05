using Vystral.Windows.Services;
using Xunit;

namespace Vystral.Tests.SteamAccount;

/// <summary>In-memory stand-in for Windows Credential Manager.</summary>
public sealed class FakeSecretStore : ISecretStore
{
    public Dictionary<string, string> Items { get; } = new(StringComparer.OrdinalIgnoreCase);
    public int Writes { get; private set; }

    public string? Read(string target) => Items.TryGetValue(target, out var v) ? v : null;

    public bool Write(string target, string secret)
    {
        Writes++;
        Items[target] = secret;
        return true;
    }

    public bool Delete(string target)
    {
        Items.Remove(target);
        return true;
    }
}

public sealed class SteamApiKeyStoreTests
{
    private const string Key = "0123456789ABCDEF0123456789ABCDEF";

    [Theory]
    [InlineData(Key, true)]
    [InlineData("0123456789abcdef0123456789abcdef", false)] // stored form is upper-case
    [InlineData("0123456789ABCDEF0123456789ABCDE", false)]
    [InlineData("0123456789ABCDEF0123456789ABCDEF0", false)]
    [InlineData("0123456789ABCDEF0123456789ABCDEG", false)]
    [InlineData("", false)]
    [InlineData(null, false)]
    public void IsValidFormat_requires_32_hex_characters(string? key, bool valid) =>
        Assert.Equal(valid, SteamApiKeyStore.IsValidFormat(key));

    [Theory]
    [InlineData("  0123456789abcdef0123456789abcdef \n", Key)]
    [InlineData(Key, Key)]
    [InlineData("0123456789abcdef0123456789abcdeZ", null)]
    [InlineData("key=0123456789abcdef0123456789abcdef", null)]
    public void Normalize_trims_and_uppercases_valid_keys_only(string pasted, string? expected) =>
        Assert.Equal(expected, SteamApiKeyStore.Normalize(pasted));

    [Fact]
    public void Set_writes_only_to_the_named_credential_and_Get_reads_it_back()
    {
        var fake = new FakeSecretStore();
        var store = new SteamApiKeyStore(fake);
        Assert.False(store.IsConfigured);
        Assert.Null(store.MaskedSuffix);

        Assert.True(store.Set(Key));

        Assert.Equal(Key, fake.Items["VYSTRAL/SteamWebApiKey"]);
        Assert.Single(fake.Items);
        Assert.Equal(Key, store.Get());
        Assert.True(store.IsConfigured);
    }

    [Fact]
    public void MaskedSuffix_reveals_only_the_last_four_characters()
    {
        var store = new SteamApiKeyStore(new FakeSecretStore());
        store.Set(Key);
        Assert.Equal("••••CDEF", store.MaskedSuffix);
        Assert.DoesNotContain("0123", store.MaskedSuffix);
    }

    [Fact]
    public void Set_rejects_malformed_keys_without_writing()
    {
        var fake = new FakeSecretStore();
        var store = new SteamApiKeyStore(fake);
        Assert.Throws<ArgumentException>(() => store.Set("not-a-key"));
        Assert.Equal(0, fake.Writes);
    }

    [Fact]
    public void Get_ignores_a_tampered_stored_value()
    {
        var fake = new FakeSecretStore();
        fake.Items[SteamApiKeyStore.Target] = "<script>";
        var store = new SteamApiKeyStore(fake);
        Assert.Null(store.Get());
        Assert.False(store.IsConfigured);
    }

    [Fact]
    public void Clear_deletes_the_credential()
    {
        var fake = new FakeSecretStore();
        var store = new SteamApiKeyStore(fake);
        store.Set(Key);
        store.Clear();
        Assert.Empty(fake.Items);
        Assert.False(store.IsConfigured);
    }
}
