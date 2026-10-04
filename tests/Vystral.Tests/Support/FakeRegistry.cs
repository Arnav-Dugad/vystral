using Vystral.Windows.Integrations;

namespace Vystral.Tests.Support;

/// <summary>In-memory registry for adapter tests. Paths are case-insensitive like the real registry.</summary>
public sealed class FakeRegistry : IRegistryReader
{
    private readonly Dictionary<string, Dictionary<string, object>> _keys = new(StringComparer.OrdinalIgnoreCase);

    public FakeRegistry Set(Hive hive, string path, string name, object value)
    {
        var full = Key(hive, path);
        if (!_keys.TryGetValue(full, out var values)) _keys[full] = values = new(StringComparer.OrdinalIgnoreCase);
        values[name] = value;
        // Register every ancestor so GetSubKeyNames works.
        var parts = path.Split('\\');
        for (var i = 1; i < parts.Length; i++)
        {
            var parent = Key(hive, string.Join('\\', parts[..i]));
            if (!_keys.ContainsKey(parent)) _keys[parent] = new(StringComparer.OrdinalIgnoreCase);
        }
        return this;
    }

    public FakeRegistry CreateKey(Hive hive, string path)
    {
        var full = Key(hive, path);
        if (!_keys.ContainsKey(full)) _keys[full] = new(StringComparer.OrdinalIgnoreCase);
        var parts = path.Split('\\');
        for (var i = 1; i < parts.Length; i++)
        {
            var parent = Key(hive, string.Join('\\', parts[..i]));
            if (!_keys.ContainsKey(parent)) _keys[parent] = new(StringComparer.OrdinalIgnoreCase);
        }
        return this;
    }

    public object? GetValue(Hive hive, string path, string name) =>
        _keys.TryGetValue(Key(hive, path), out var v) && v.TryGetValue(name, out var o) ? o : null;

    public IReadOnlyList<string> GetSubKeyNames(Hive hive, string path)
    {
        var prefix = Key(hive, path) + "\\";
        return _keys.Keys.Where(k => k.StartsWith(prefix, StringComparison.OrdinalIgnoreCase))
            .Select(k => k[prefix.Length..]).Where(k => !k.Contains('\\')).ToList();
    }

    public IReadOnlyList<string> GetValueNames(Hive hive, string path) =>
        _keys.TryGetValue(Key(hive, path), out var v) ? v.Keys.ToList() : [];

    private static string Key(Hive hive, string path) => $"{hive}\\{path.TrimEnd('\\')}";
}
