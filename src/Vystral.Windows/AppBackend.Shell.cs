using Vystral.Windows.Bridge;
using Vystral.Windows.Services;

namespace Vystral.Windows;

/// <summary>
/// Track G: Windows shell integration — the Windows accent colour and the Mica backdrop
/// (<c>system.accent</c>, <c>window.backdrop</c>). Clickable notifications live in the shell
/// (Vystral.App/Host/Notifications.cs) and need no bridge methods beyond <c>notifications.status</c>.
/// </summary>
public sealed partial class AppBackend
{
    /// <summary>Shown when no shell is attached (tests) or it failed: no Mica, a neutral Windows blue.</summary>
    public static readonly SystemAppearanceDto NoSystemAppearance = new(
        "#0078D4", ["#429CE3", "#76B9ED", "#99EBFF"], ["#005A9E", "#004275", "#002642"],
        SystemDark: true, HighContrast: false, TransparencyEffects: false, EnergySaver: false,
        BackdropSupported: false, BackdropRequested: false, BackdropPolicy.None, "unsupported");

    private IShellAppearanceHost? _appearanceHost;

    /// <summary>The shell's accent/backdrop implementation. Changes are forwarded to the UI as <c>system.accent</c>.</summary>
    public IShellAppearanceHost? AppearanceHost
    {
        get => _appearanceHost;
        set
        {
            if (_appearanceHost is not null) _appearanceHost.Changed -= OnAppearanceChanged;
            _appearanceHost = value;
            if (value is not null) value.Changed += OnAppearanceChanged;
        }
    }

    private void OnAppearanceChanged(SystemAppearanceDto dto) => _events.Emit("system.accent", dto);

    private void RegisterShellHandlers()
    {
        Dispatcher.Register("system.accent", _ => Task.FromResult<object?>(_appearanceHost?.Current ?? NoSystemAppearance));
        Dispatcher.Register<FlagValueParams>("window.backdrop", (p, _) =>
            Task.FromResult<object?>(_appearanceHost?.RequestBackdrop(p.Value) ?? NoSystemAppearance));
    }
}
