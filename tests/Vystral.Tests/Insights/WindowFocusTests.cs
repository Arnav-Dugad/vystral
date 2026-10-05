using Vystral.Windows.Launch;
using Xunit;

namespace Vystral.Tests.Insights;

public sealed class WindowFocusTests
{
    private static WindowCandidate W(int handle, int pid, long area, bool visible = true, bool owned = false, bool cloaked = false) =>
        new(new IntPtr(handle), pid, visible, owned, cloaked, area);

    [Fact]
    public void Picks_the_largest_visible_unowned_window_of_the_game()
    {
        var windows = new[]
        {
            W(1, 10, 800 * 600),
            W(2, 10, 1920 * 1080),
            W(3, 99, 2560 * 1440),               // another app
            W(4, 10, 4000 * 4000, visible: false), // hidden helper
            W(5, 10, 3000 * 3000, owned: true),    // a dialog owned by the game window
            W(6, 10, 3500 * 3500, cloaked: true),  // a cloaked (virtual-desktop / UWP) window
        };
        Assert.Equal(new IntPtr(2), WindowFocus.Pick(windows, [10]));
    }

    [Fact]
    public void Nothing_to_pick_returns_zero()
    {
        Assert.Equal(IntPtr.Zero, WindowFocus.Pick([W(1, 10, 100)], [11]));
        Assert.Equal(IntPtr.Zero, WindowFocus.Pick([W(1, 10, 0)], [10]));
        Assert.Equal(IntPtr.Zero, WindowFocus.Pick([], [10]));
    }

    [Fact]
    public void No_processes_means_no_focus()
    {
        Assert.False(WindowFocus.BringToFront([]));
    }
}
