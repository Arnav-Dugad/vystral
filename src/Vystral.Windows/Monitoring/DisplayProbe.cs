using System.Runtime.InteropServices;

namespace Vystral.Windows.Monitoring;

/// <param name="RefreshHz">Current refresh rate (dmDisplayFrequency); null if unknown.</param>
/// <param name="HdrSupported">The display can do HDR (advanced colour); null if unknown.</param>
/// <param name="HdrEnabled">HDR is currently on; null if unknown.</param>
public sealed record DisplayState(string? DeviceName, int? RefreshHz, bool? HdrSupported, bool? HdrEnabled);

/// <summary>
/// Read-only display information for the monitor showing a window, using documented APIs:
/// MonitorFromWindow + EnumDisplaySettings (refresh rate) and QueryDisplayConfig +
/// DisplayConfigGetDeviceInfo(GET_ADVANCED_COLOR_INFO) (HDR). Nothing is changed.
/// </summary>
public static class DisplayProbe
{
    public static DisplayState? ForWindow(nint hwnd)
    {
        try
        {
            var monitor = MonitorFromWindow(hwnd, 2 /* MONITOR_DEFAULTTONEAREST */);
            if (monitor == 0) return null;
            var info = new MonitorInfoEx { Size = Marshal.SizeOf<MonitorInfoEx>() };
            if (!GetMonitorInfoW(monitor, ref info)) return null;
            var device = info.Device;

            int? hz = null;
            var mode = new DevMode { Size = (ushort)Marshal.SizeOf<DevMode>() };
            if (EnumDisplaySettingsW(device, -1 /* ENUM_CURRENT_SETTINGS */, ref mode) && mode.DisplayFrequency > 1)
                hz = (int)mode.DisplayFrequency;

            var (supported, enabled) = ReadAdvancedColor(device);
            return new DisplayState(device, hz, supported, enabled);
        }
        catch (Exception ex) when (ex is DllNotFoundException or EntryPointNotFoundException or MarshalDirectiveException)
        {
            return null;
        }
    }

    private static (bool?, bool?) ReadAdvancedColor(string gdiDevice)
    {
        if (GetDisplayConfigBufferSizes(2 /* QDC_ONLY_ACTIVE_PATHS */, out var pathCount, out var modeCount) != 0) return (null, null);
        var paths = new PathInfo[pathCount];
        var modes = new byte[modeCount * 64]; // DISPLAYCONFIG_MODE_INFO is 64 bytes; not inspected
        if (QueryDisplayConfig(2, ref pathCount, paths, ref modeCount, modes, 0) != 0) return (null, null);

        for (var i = 0; i < pathCount; i++)
        {
            var p = paths[i];
            var source = new SourceName
            {
                Header = new DeviceInfoHeader { Type = 1 /* GET_SOURCE_NAME */, Size = (uint)Marshal.SizeOf<SourceName>(), AdapterId = p.SourceAdapterId, Id = p.SourceId },
            };
            if (DisplayConfigGetDeviceInfo(ref source) != 0) continue;
            if (!string.Equals(source.ViewGdiDeviceName, gdiDevice, StringComparison.OrdinalIgnoreCase)) continue;

            var color = new AdvancedColorInfo
            {
                Header = new DeviceInfoHeader { Type = 9 /* GET_ADVANCED_COLOR_INFO */, Size = (uint)Marshal.SizeOf<AdvancedColorInfo>(), AdapterId = p.TargetAdapterId, Id = p.TargetId },
            };
            if (DisplayConfigGetDeviceInfo(ref color) != 0) return (null, null);
            return ((color.Value & 0x1) != 0, (color.Value & 0x2) != 0);
        }
        return (null, null);
    }

    // ---------------- interop ----------------

    [StructLayout(LayoutKind.Sequential)]
    private struct Luid { public uint Low; public int High; }

    [StructLayout(LayoutKind.Sequential)]
    private struct PathInfo
    {
        public Luid SourceAdapterId;
        public uint SourceId;
        public uint SourceModeInfoIdx;
        public uint SourceStatusFlags;
        public Luid TargetAdapterId;
        public uint TargetId;
        public uint TargetModeInfoIdx;
        public uint OutputTechnology;
        public uint Rotation;
        public uint Scaling;
        public uint RefreshNumerator;
        public uint RefreshDenominator;
        public uint ScanLineOrdering;
        public int TargetAvailable;
        public uint TargetStatusFlags;
        public uint Flags;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct DeviceInfoHeader
    {
        public uint Type;
        public uint Size;
        public Luid AdapterId;
        public uint Id;
    }

    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    private struct SourceName
    {
        public DeviceInfoHeader Header;
        [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 32)] public string ViewGdiDeviceName;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct AdvancedColorInfo
    {
        public DeviceInfoHeader Header;
        public uint Value;
        public uint ColorEncoding;
        public uint BitsPerColorChannel;
    }

    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    private struct MonitorInfoEx
    {
        public int Size;
        public int Left, Top, Right, Bottom;
        public int WLeft, WTop, WRight, WBottom;
        public uint Flags;
        [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 32)] public string Device;
    }

    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    private struct DevMode
    {
        [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 32)] public string DeviceName;
        public ushort SpecVersion;
        public ushort DriverVersion;
        public ushort Size;
        public ushort DriverExtra;
        public uint Fields;
        public int PositionX;
        public int PositionY;
        public uint DisplayOrientation;
        public uint DisplayFixedOutput;
        public short Color;
        public short Duplex;
        public short YResolution;
        public short TTOption;
        public short Collate;
        [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 32)] public string FormName;
        public ushort LogPixels;
        public uint BitsPerPel;
        public uint PelsWidth;
        public uint PelsHeight;
        public uint DisplayFlags;
        public uint DisplayFrequency;
        public uint IcmMethod;
        public uint IcmIntent;
        public uint MediaType;
        public uint DitherType;
        public uint Reserved1;
        public uint Reserved2;
        public uint PanningWidth;
        public uint PanningHeight;
    }

    [DllImport("user32.dll")] private static extern nint MonitorFromWindow(nint hwnd, uint flags);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] private static extern bool GetMonitorInfoW(nint monitor, ref MonitorInfoEx info);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] private static extern bool EnumDisplaySettingsW(string device, int mode, ref DevMode devMode);
    [DllImport("user32.dll")] private static extern int GetDisplayConfigBufferSizes(uint flags, out int numPaths, out int numModes);
    [DllImport("user32.dll")] private static extern int QueryDisplayConfig(uint flags, ref int numPaths, [Out] PathInfo[] paths, ref int numModes, [Out] byte[] modes, nint topologyId);
    [DllImport("user32.dll")] private static extern int DisplayConfigGetDeviceInfo(ref SourceName request);
    [DllImport("user32.dll")] private static extern int DisplayConfigGetDeviceInfo(ref AdvancedColorInfo request);
}
