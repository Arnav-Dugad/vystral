using Vystral.Windows.Services;

namespace Vystral.Windows;

public sealed partial class AppBackend
{
    private readonly SystemStatusService _systemStatus = new();

    /// <summary>Track L: the Immersive system bar — PC battery, network and controller batteries (read-only).</summary>
    private void RegisterImmersiveHandlers()
    {
        Dispatcher.Register("system.status", _ => Task.FromResult<object?>(_systemStatus.Current));
    }
}
