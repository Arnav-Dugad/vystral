using System.Diagnostics;
using System.Runtime.InteropServices;

namespace Vystral.Windows.Monitoring;

/// <summary>
/// Read-only kernel graphics statistics from gdi32's D3DKMT functions (no admin, no process handles):
/// adapters are listed once, after which each reading is one <c>D3DKMTQueryStatistics</c> call per 3D
/// engine and per dedicated memory segment, addressed by adapter LUID (no adapter handle is kept open).
/// Struct offsets are the x64 layouts of d3dkmthk.h (Windows 10 2004+), checked against the WDK metadata.
/// </summary>
public sealed unsafe class D3dkmtStats : IGpuStats
{
    // D3DKMT_QUERYSTATISTICS (808 bytes on x64): Type @0, AdapterLuid @4, hProcess @16, QueryResult @24, query union @800.
    private const int QsSize = 808, QsType = 0, QsLuid = 4, QsResult = 24, QsQueryId = 800;
    private const int TypeAdapter = 0, TypeSegment = 3, TypeNode = 5;
    // Result layouts: ADAPTER_INFORMATION {NbSegments @0, NodeCount @4}; NODE_INFORMATION.GlobalInformation.RunningTime @0;
    // SEGMENT_INFORMATION {BytesResident @16, Aperture @40}.
    private const int SegBytesResident = 16, SegAperture = 40;
    // D3DKMT_QUERYADAPTERINFO types and DXGK_ENGINE_TYPE_3D.
    private const int QaiAdapterType = 15, QaiNodeMetadata = 25, EngineType3D = 1;
    // D3DKMT_ADAPTERTYPE bits.
    private const uint RenderSupported = 1u << 0, SoftwareDevice = 1u << 2, HybridIntegrated = 1u << 5;

    public static bool Supported => Environment.Is64BitProcess && OperatingSystem.IsWindowsVersionAtLeast(10, 0, 19041);

    public IReadOnlyList<GpuAdapter> Adapters()
    {
        if (!Supported) return [];
        var found = new List<GpuAdapter>();
        var e = new EnumAdapters2();
        if (D3DKMTEnumAdapters2(&e) != 0 || e.NumAdapters == 0 || e.NumAdapters > 64) return found;
        var infos = new AdapterInfo[e.NumAdapters];
        fixed (AdapterInfo* p = infos)
        {
            e.Adapters = p;
            if (D3DKMTEnumAdapters2(&e) != 0) return found;
        }
        for (var i = 0; i < e.NumAdapters && i < infos.Length; i++)
        {
            var info = infos[i];
            try
            {
                if (Describe(info) is { } adapter) found.Add(adapter);
            }
            finally
            {
                var close = new CloseAdapter { Adapter = info.Adapter };
                D3DKMTCloseAdapter(&close);
            }
        }
        return found;
    }

    private static GpuAdapter? Describe(AdapterInfo info)
    {
        uint type = 0;
        if (QueryAdapterInfo(info.Adapter, QaiAdapterType, &type, sizeof(uint)) != 0) return null;
        if ((type & SoftwareDevice) != 0 || (type & RenderSupported) == 0) return null;

        var stats = stackalloc byte[QsSize];
        if (Query(stats, TypeAdapter, info.Luid, 0) != 0) return null;
        var segments = *(uint*)(stats + QsResult);
        var nodes = *(uint*)(stats + QsResult + 4);

        var nodes3D = new List<uint>();
        var meta = stackalloc byte[NodeMetadataSize];
        for (uint n = 0; n < nodes && n < 256; n++)
        {
            new Span<byte>(meta, NodeMetadataSize).Clear();
            *(uint*)meta = n; // NodeOrdinalAndAdapterIndex
            if (QueryAdapterInfo(info.Adapter, QaiNodeMetadata, meta, NodeMetadataSize) == 0 && *(int*)(meta + 4) == EngineType3D)
                nodes3D.Add(n);
        }
        if (nodes3D.Count == 0) return null;

        var dedicated = new List<uint>();
        for (uint s = 0; s < segments && s < 64; s++)
        {
            if (Query(stats, TypeSegment, info.Luid, s) == 0 && *(uint*)(stats + QsResult + SegAperture) == 0)
                dedicated.Add(s);
        }
        var integrated = (type & HybridIntegrated) != 0 || dedicated.Count == 0;
        return new GpuAdapter(info.Luid, integrated, nodes3D, dedicated);
    }

    public long? NodeRunningTime(long luid, uint node)
    {
        var stats = stackalloc byte[QsSize];
        return Query(stats, TypeNode, luid, node) == 0 ? *(long*)(stats + QsResult) : null;
    }

    public long? DedicatedBytes(GpuAdapter adapter)
    {
        var stats = stackalloc byte[QsSize];
        long total = 0;
        foreach (var s in adapter.DedicatedSegments)
        {
            if (Query(stats, TypeSegment, adapter.Luid, s) != 0) return null;
            total += *(long*)(stats + QsResult + SegBytesResident);
        }
        return total;
    }

    public long Now()
    {
        var ts = Stopwatch.GetTimestamp();
        var f = Stopwatch.Frequency;
        return f == 10_000_000 ? ts : ts / f * 10_000_000 + ts % f * 10_000_000 / f;
    }

    private static int Query(byte* buffer, int type, long luid, uint id)
    {
        new Span<byte>(buffer, QsSize).Clear();
        *(int*)(buffer + QsType) = type;
        *(long*)(buffer + QsLuid) = luid;
        *(uint*)(buffer + QsQueryId) = id;
        return D3DKMTQueryStatistics(buffer);
    }

    private static int QueryAdapterInfo(uint adapter, int type, void* data, int size)
    {
        var q = new QueryAdapterInfoArgs { Adapter = adapter, Type = type, PrivateDriverData = data, PrivateDriverDataSize = (uint)size };
        return D3DKMTQueryAdapterInfo(&q);
    }

    private const int NodeMetadataSize = 78; // D3DKMT_NODEMETADATA: NodeOrdinalAndAdapterIndex @0, DXGK_NODEMETADATA.EngineType @4

    [StructLayout(LayoutKind.Sequential, Pack = 4)]
    private struct AdapterInfo // D3DKMT_ADAPTERINFO, 20 bytes (LUID is 4-byte aligned)
    {
        public uint Adapter;
        public long Luid; // LUID {LowPart, HighPart} read as one little-endian 64-bit value
        public uint NumOfSources;
        public int PrecisePresentRegionsPreferred;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct EnumAdapters2 // D3DKMT_ENUMADAPTERS2, 16 bytes
    {
        public uint NumAdapters;
        public AdapterInfo* Adapters;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct CloseAdapter { public uint Adapter; }

    [StructLayout(LayoutKind.Sequential)]
    private struct QueryAdapterInfoArgs // D3DKMT_QUERYADAPTERINFO, 24 bytes
    {
        public uint Adapter;
        public int Type;
        public void* PrivateDriverData;
        public uint PrivateDriverDataSize;
    }

    [DllImport("gdi32.dll")] private static extern int D3DKMTEnumAdapters2(EnumAdapters2* args);
    [DllImport("gdi32.dll")] private static extern int D3DKMTCloseAdapter(CloseAdapter* args);
    [DllImport("gdi32.dll")] private static extern int D3DKMTQueryAdapterInfo(QueryAdapterInfoArgs* args);
    [DllImport("gdi32.dll")] private static extern int D3DKMTQueryStatistics(byte* args);
}
