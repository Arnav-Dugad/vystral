using System.Xml.Linq;

namespace Vystral.Windows.Services;

/// <summary>
/// Builds toast XML for protocol activation: selecting the toast (popup or notification centre)
/// makes Windows open <c>launchUri</c> through the registered <c>vystral:</c> scheme. Text is
/// added through the XML DOM, so titles from game metadata can't inject markup.
/// </summary>
public static class ToastXml
{
    public const int MaxTitle = 120;
    public const int MaxBody = 240;

    public static string Build(string title, string body, string? launchUri)
    {
        var binding = new XElement("binding", new XAttribute("template", "ToastGeneric"),
            new XElement("text", Clean(title, MaxTitle)),
            new XElement("text", Clean(body, MaxBody)));
        var toast = new XElement("toast", new XElement("visual", binding));
        if (launchUri is not null)
        {
            toast.SetAttributeValue("activationType", "protocol");
            toast.SetAttributeValue("launch", launchUri);
        }
        return toast.ToString(SaveOptions.DisableFormatting);
    }

    /// <summary>Strips control characters and unpaired surrogates (invalid in XML) and trims to a length.</summary>
    public static string Clean(string s, int max)
    {
        var sb = new System.Text.StringBuilder(Math.Min(s.Length, max * 2));
        for (var i = 0; i < s.Length; i++)
        {
            var c = s[i];
            if (char.IsHighSurrogate(c) && i + 1 < s.Length && char.IsLowSurrogate(s[i + 1])) { sb.Append(c).Append(s[++i]); continue; }
            if (char.IsControl(c) || char.IsSurrogate(c) || c is '￾' or '￿') continue;
            sb.Append(c);
        }
        var clean = sb.ToString().Trim();
        // Don't split a surrogate pair when trimming.
        if (clean.Length <= max) return clean;
        var cut = max - 1;
        if (char.IsHighSurrogate(clean[cut - 1])) cut--;
        return clean[..cut] + "…";
    }
}
