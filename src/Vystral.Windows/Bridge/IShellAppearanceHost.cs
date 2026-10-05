namespace Vystral.Windows.Bridge;

/// <summary>
/// Windows appearance as seen by the UI (bridge method and event <c>system.accent</c>). Colours are
/// <c>#RRGGBB</c>. <see cref="Backdrop"/> is what the window is actually drawing: "mica" only while
/// the UI asked for it and Windows can show it; otherwise "none" with a <see cref="BackdropReason"/>.
/// </summary>
public sealed record SystemAppearanceDto(
    string Accent,
    IReadOnlyList<string> AccentLight,
    IReadOnlyList<string> AccentDark,
    bool SystemDark,
    bool HighContrast,
    bool TransparencyEffects,
    bool EnergySaver,
    bool BackdropSupported,
    bool BackdropRequested,
    string Backdrop,
    string? BackdropReason);

/// <summary>
/// Track G: the Windows accent colour and the Mica window backdrop, implemented by the WinUI shell
/// and attached to <see cref="AppBackend.AppearanceHost"/>. Members are thread-safe and never throw.
/// </summary>
public interface IShellAppearanceHost
{
    SystemAppearanceDto Current { get; }

    /// <summary>The UI's wish for a Mica backdrop (Living Canvas off, a theme that suits it). Returns the resulting state.</summary>
    SystemAppearanceDto RequestBackdrop(bool wanted);

    /// <summary>Raised (on any thread) when the accent, system theme, effects or backdrop state change.</summary>
    event Action<SystemAppearanceDto>? Changed;
}
