using System.Text.RegularExpressions;
using Vystral.Windows.Services;

namespace Vystral.Windows.Ai;

/// <summary>Track C5: the optional cloud AI providers. "compatible" is any OpenAI-compatible HTTPS endpoint.</summary>
public enum CloudAiProvider
{
    Anthropic,
    OpenAi,
    Gemini,
    Compatible,
}

public static class CloudAiProviders
{
    public static readonly CloudAiProvider[] All = [CloudAiProvider.Anthropic, CloudAiProvider.OpenAi, CloudAiProvider.Gemini, CloudAiProvider.Compatible];

    public static string Id(CloudAiProvider p) => p switch
    {
        CloudAiProvider.Anthropic => "anthropic",
        CloudAiProvider.OpenAi => "openai",
        CloudAiProvider.Gemini => "gemini",
        _ => "compatible",
    };

    public static CloudAiProvider? FromId(string? id) => id switch
    {
        "anthropic" => CloudAiProvider.Anthropic,
        "openai" => CloudAiProvider.OpenAi,
        "gemini" => CloudAiProvider.Gemini,
        "compatible" => CloudAiProvider.Compatible,
        _ => null,
    };

    public static string Name(CloudAiProvider p) => p switch
    {
        CloudAiProvider.Anthropic => "Claude",
        CloudAiProvider.OpenAi => "ChatGPT",
        CloudAiProvider.Gemini => "Gemini",
        _ => "OpenAI-compatible",
    };

    public static string Company(CloudAiProvider p) => p switch
    {
        CloudAiProvider.Anthropic => "Anthropic",
        CloudAiProvider.OpenAi => "OpenAI",
        CloudAiProvider.Gemini => "Google",
        _ => "the endpoint you entered",
    };

    /// <summary>Settings keys: the explicit per-provider opt-in and the chosen model (the key itself is never a setting).</summary>
    public static string OptInSetting(CloudAiProvider p) => $"ai.cloud.{Id(p)}.optIn";
    public static string ModelSetting(CloudAiProvider p) => $"ai.cloud.{Id(p)}.model";
    public const string CompatibleUrlSetting = "ai.cloud.compatible.url";
    public const string ProviderSetting = "ai.provider";

    /// <summary>Claude's choices are fixed (current model IDs); the default is Claude Sonnet 5.5.</summary>
    public static readonly string[] ClaudeModels = ["claude-sonnet-5-5", "claude-opus-5-5", "claude-haiku-4-5-20251001"];
    public const string ClaudeDefault = "claude-sonnet-5-5";
    /// <summary>Used when listing OpenAI's or Google's models fails and nothing was chosen yet.</summary>
    public const string OpenAiDefault = "gpt-5-mini";
    public const string GeminiDefault = "gemini-2.5-flash";

    public static string ModelLabel(string model) => model switch
    {
        "claude-sonnet-5-5" => "Claude Sonnet 5.5",
        "claude-opus-5-5" => "Claude Opus 5.5",
        "claude-haiku-4-5-20251001" => "Claude Haiku 4.5",
        _ => model,
    };
}

/// <summary>
/// The user's own API keys for cloud AI. Each lives only in Windows Credential Manager (generic credential
/// "VYSTRAL/AI-&lt;Provider&gt;"), never in SQLite, settings, the log or a bridge response: the page only learns
/// whether a key exists and its last four characters ("…1234").
/// </summary>
public sealed partial class CloudAiKeyStore(ISecretStore store)
{
    public static string Target(CloudAiProvider p) => p switch
    {
        CloudAiProvider.Anthropic => "VYSTRAL/AI-Anthropic",
        CloudAiProvider.OpenAi => "VYSTRAL/AI-OpenAI",
        CloudAiProvider.Gemini => "VYSTRAL/AI-Gemini",
        _ => "VYSTRAL/AI-Compatible",
    };

    public static string Comment(CloudAiProvider p) => p switch
    {
        CloudAiProvider.Anthropic => "Your Anthropic API key, used by VYSTRAL's optional cloud AI (Claude).",
        CloudAiProvider.OpenAi => "Your OpenAI API key, used by VYSTRAL's optional cloud AI (ChatGPT).",
        CloudAiProvider.Gemini => "Your Google AI Studio API key, used by VYSTRAL's optional cloud AI (Gemini).",
        _ => "Your API key for the OpenAI-compatible endpoint you added to VYSTRAL's optional cloud AI.",
    };

    /// <summary>Trims a pasted key; null when it can't be an API key (letters, digits, '-', '_', '.'; 16–250 characters).</summary>
    public static string? Normalize(string? pasted)
    {
        var k = pasted?.Trim();
        if (string.IsNullOrEmpty(k)) return null;
        if (k.StartsWith("Bearer ", StringComparison.OrdinalIgnoreCase)) k = k[7..].Trim();
        return KeyPattern().IsMatch(k) ? k : null;
    }

    /// <summary>A friendly hint when a key clearly belongs to another provider (null when it looks fine).</summary>
    public static string? Mismatch(CloudAiProvider p, string key)
    {
        var claude = key.StartsWith("sk-ant-", StringComparison.Ordinal);
        var google = key.StartsWith("AIza", StringComparison.Ordinal);
        return p switch
        {
            CloudAiProvider.Anthropic when google => "That looks like a Google key. Claude keys start with “sk-ant-”.",
            CloudAiProvider.Anthropic when !claude && key.StartsWith("sk-", StringComparison.Ordinal) => "That looks like an OpenAI key. Claude keys start with “sk-ant-”.",
            CloudAiProvider.OpenAi when claude => "That looks like a Claude key. Add it under Claude instead.",
            CloudAiProvider.OpenAi when google => "That looks like a Google key. Add it under Gemini instead.",
            CloudAiProvider.Gemini when claude => "That looks like a Claude key. Add it under Claude instead.",
            CloudAiProvider.Gemini when key.StartsWith("sk-", StringComparison.Ordinal) => "That looks like an OpenAI key. Add it under ChatGPT instead.",
            _ => null,
        };
    }

    /// <summary>Only the last four characters are ever shown: "…1234".</summary>
    public static string Mask(string key) => key.Length >= 8 ? $"…{key[^4..]}" : "…";

    public string? Get(CloudAiProvider p)
    {
        var k = store.Read(Target(p));
        return k is not null && Normalize(k) == k ? k : null;
    }

    public bool IsConfigured(CloudAiProvider p) => Get(p) is not null;

    public string? Masked(CloudAiProvider p) => Get(p) is { } k ? Mask(k) : null;

    public bool Set(CloudAiProvider p, string key)
    {
        if (Normalize(key) != key) throw new ArgumentException("Not a valid key.", nameof(key));
        return store.Write(Target(p), key);
    }

    public void Clear(CloudAiProvider p) => store.Delete(Target(p));

    [GeneratedRegex(@"\A[A-Za-z0-9_\-.]{16,250}\z")]
    private static partial Regex KeyPattern();
}
