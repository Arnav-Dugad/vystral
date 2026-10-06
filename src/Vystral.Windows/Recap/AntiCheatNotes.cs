using Vystral.Core.Data;
using Vystral.Windows.DataSources;
using Vystral.Windows.Launch;

namespace Vystral.Windows.Recap;

/// <summary>An informative note about a game's kernel-level anti-cheat (pre-flight card and game page).</summary>
public sealed record AntiCheatNoteDto(IReadOnlyList<string> Kernel, IReadOnlyList<string> Other, string Headline, IReadOnlyList<string> Notes, string Source,
    string? Updated);

/// <summary>
/// Pure note logic (unit-tested). Only statements VYSTRAL can stand behind: which product AreWeAntiCheatYet
/// lists, that it is a product widely documented to load a kernel driver, and what VYSTRAL's own read-only
/// tools do. Nothing here claims how an anti-cheat will treat VYSTRAL; that is the anti-cheat's decision.
/// </summary>
public static class AntiCheatNotes
{
    public const string Source = "Anti-cheat per AreWeAntiCheatYet (community-maintained).";

    public const string NeverInteracts = "VYSTRAL never interacts with it: it doesn't inject code into games, draw overlays inside them or read their memory.";

    public const string Detection = "To see that the game is running, VYSTRAL only asks Windows which programs are running (read-only).";

    public const string FpsCapture = "Frame-rate capture is on: it uses Intel PresentMon, which reads the frame timing events Windows itself publishes (ETW) and doesn't hook into the game.";

    public const string Decides = "Each anti-cheat decides for itself what other software it allows; VYSTRAL can't speak for it.";

    /// <summary>A note when the game is listed with at least one kernel-level product; otherwise null.</summary>
    public static AntiCheatNoteDto? For(AntiCheatRow? row, bool fpsCaptureOn)
    {
        if (row is null) return null;
        var names = row.AntiCheats.Where(n => !string.IsNullOrWhiteSpace(n)).Select(n => n.Trim()).Distinct(StringComparer.OrdinalIgnoreCase).ToList();
        var kernel = names.Where(AntiCheatClient.KernelLevel.Contains).ToList();
        if (kernel.Count == 0) return null;
        var other = names.Except(kernel, StringComparer.OrdinalIgnoreCase).ToList();
        var headline = $"Uses kernel anti-cheat ({Join(kernel)}). VYSTRAL never interacts with it.";
        var notes = new List<string> { NeverInteracts, Detection };
        if (fpsCaptureOn) notes.Add(FpsCapture);
        notes.Add(Decides);
        return new AntiCheatNoteDto(kernel, other, headline, notes, Source, row.DateChanged);
    }

    /// <summary>The pre-flight row for <see cref="For"/>'s note (status 'info': it never warns or blocks).</summary>
    public static PreflightCheckDto? Preflight(AntiCheatRow? row, bool fpsCaptureOn)
    {
        if (For(row, fpsCaptureOn) is not { } note) return null;
        var detail = fpsCaptureOn
            ? $"{note.Headline} Frame-rate capture reads Windows' own frame events (ETW) and doesn't touch the game. {Source}"
            : $"{note.Headline} {Source}";
        return new PreflightCheckDto("antiCheat", "Anti-cheat", "info", $"{Join(note.Kernel)} · kernel", detail);
    }

    internal static string Join(IReadOnlyList<string> names) => names.Count switch
    {
        0 => "",
        1 => names[0],
        2 => $"{names[0]} and {names[1]}",
        _ => $"{string.Join(", ", names.Take(names.Count - 1))} and {names[^1]}",
    };
}
