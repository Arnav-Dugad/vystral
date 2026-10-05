using Vystral.Windows.Monitoring;

namespace Vystral.Windows.Launch;

/// <summary>
/// Decides whether frame rate can be captured for the next session (shared by the app and the
/// background tracker, so both record FPS under exactly the same conditions).
/// </summary>
public static class FpsCapturePlanner
{
    /// <summary>Where the verified PresentMon executable lives inside the data folder.</summary>
    public static string ExePath(string toolsDir) => Path.Combine(toolsDir, PresentMonRelease.Pinned.FileName);

    public static FpsCapturePlan Plan(bool enabled, bool installed, string exePath)
    {
        if (!enabled) return new FpsCapturePlan(null, PerfSampler.FpsUnavailable);
        if (!installed)
            return new FpsCapturePlan(null, "Frame-rate capture is on, but PresentMon isn't installed (or its file failed verification). Reinstall it in Settings › Launching & sessions. FPS is not recorded.");
        return PresentMonInstaller.CheckPermission() switch
        {
            FpsPermission.Granted => new FpsCapturePlan(exePath, ""),
            FpsPermission.SignOutRequired => new FpsCapturePlan(null, "Frame-rate capture is ready, but Windows applies the Performance Log Users permission only after you sign out and back in. FPS is not recorded."),
            _ => new FpsCapturePlan(null, "Frame-rate capture needs your account in the Performance Log Users group (Settings › Launching & sessions). FPS is not recorded."),
        };
    }

    /// <summary>The plan for a PresentMon copy in <paramref name="toolsDir"/>, verified against its pinned SHA-256.</summary>
    public static FpsCapturePlan Plan(bool enabled, string toolsDir)
    {
        if (!enabled) return Plan(false, false, "");
        var exe = ExePath(toolsDir);
        return Plan(true, PresentMonInstaller.VerifyFile(exe, PresentMonRelease.Pinned.Sha256), exe);
    }
}
