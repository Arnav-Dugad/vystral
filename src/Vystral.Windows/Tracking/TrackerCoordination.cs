using System.Runtime.InteropServices;

namespace Vystral.Windows.Tracking;

/// <summary>Whether the PC is saving power (on battery, or battery/energy saver is on).</summary>
public interface IPowerStatus
{
    bool Saving { get; }
}

public sealed class WindowsPowerStatus : IPowerStatus
{
    public bool Saving
    {
        get
        {
            if (!GetSystemPowerStatus(out var s)) return false;
            return s.ACLineStatus == 0 || s.SystemStatusFlag == 1;
        }
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct SystemPowerStatus
    {
        public byte ACLineStatus, BatteryFlag, BatteryLifePercent, SystemStatusFlag;
        public int BatteryLifeTime, BatteryFullLifeTime;
    }

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool GetSystemPowerStatus(out SystemPowerStatus status);
}

/// <summary>
/// Holds a named mutex for as long as needed. A Windows mutex belongs to the thread that acquired it
/// (and is released automatically if that thread or process dies), so it is acquired and released on a
/// dedicated thread rather than on a thread-pool thread that might be retired while still owning it.
/// </summary>
public sealed class MutexHolder : IDisposable
{
    private readonly ManualResetEvent _release = new(false);
    private readonly TaskCompletionSource<bool> _acquired = new(TaskCreationOptions.RunContinuationsAsynchronously);
    private readonly Thread _thread;

    private MutexHolder(string name, TimeSpan timeout)
    {
        _thread = new Thread(() => Run(name, timeout)) { IsBackground = true, Name = "vystral-mutex" };
        _thread.Start();
    }

    /// <summary>Starts waiting for <paramref name="name"/> (up to <paramref name="timeout"/>, or until disposed).</summary>
    public static MutexHolder Acquire(string name, TimeSpan? timeout = null) => new(name, timeout ?? Timeout.InfiniteTimeSpan);

    /// <summary>Completes with true once held, or false if it timed out or was disposed first.</summary>
    public Task<bool> Acquired => _acquired.Task;

    public bool IsHeld => _acquired.Task is { IsCompletedSuccessfully: true, Result: true };

    private void Run(string name, TimeSpan timeout)
    {
        try
        {
            using var mutex = new Mutex(false, name);
            bool owned;
            try { owned = WaitHandle.WaitAny([mutex, _release], timeout) == 0; }
            catch (AbandonedMutexException e) when (e.MutexIndex == 0) { owned = true; } // previous owner crashed
            _acquired.TrySetResult(owned);
            if (!owned) return;
            _release.WaitOne();
            mutex.ReleaseMutex();
        }
        catch (Exception ex)
        {
            Services.Log.Warn("tracker", "Coordination lock failed", ex: ex);
            _acquired.TrySetResult(false);
        }
    }

    public void Dispose()
    {
        _release.Set();
        if (Thread.CurrentThread != _thread) _thread.Join(TimeSpan.FromSeconds(2));
    }
}

/// <summary>
/// The cross-process protocol between the app and the background tracker (all objects from
/// <see cref="TrackerNames"/>, per signed-in session):
/// <list type="number">
/// <item>The app holds <c>app</c> for its lifetime and, on start, sets <c>yield</c>.</item>
/// <item>Whoever tracks holds <c>tracker</c>. The background tracker gives it up when it sees the app
/// (parking any session in the hand-over note), and waits for the app to exit before taking it again.</item>
/// <item>The app releases <c>tracker</c> only when it exits, after parking its own session.</item>
/// <item><c>stop</c> asks the background tracker to exit; <c>helper</c> tells whether it is running.</item>
/// </list>
/// </summary>
public static class TrackerSignals
{
    public static bool Exists(string mutexName)
    {
        if (!Mutex.TryOpenExisting(mutexName, out var m)) return false;
        m.Dispose();
        return true;
    }

    public static void Set(string eventName)
    {
        using var e = new EventWaitHandle(false, EventResetMode.AutoReset, eventName);
        e.Set();
    }

    public static EventWaitHandle OpenEvent(string eventName) => new(false, EventResetMode.AutoReset, eventName);

    /// <summary>
    /// Runs <paramref name="action"/> while holding the named mutex (on the calling thread). If the lock can't be
    /// taken in time the action still runs: it is only there to keep the two processes from migrating at once.
    /// </summary>
    public static T WithLock<T>(string mutexName, TimeSpan timeout, Func<T> action)
    {
        using var mutex = new Mutex(false, mutexName);
        bool owned;
        try { owned = mutex.WaitOne(timeout); }
        catch (AbandonedMutexException) { owned = true; }
        try { return action(); }
        finally { if (owned) mutex.ReleaseMutex(); }
    }

    /// <summary>
    /// Asks a running background tracker to exit and waits until it has (its session parked).
    /// True when none is running any more.
    /// </summary>
    public static bool StopHelper(TrackerNames names, TimeSpan timeout)
    {
        var deadline = DateTime.UtcNow + timeout;
        while (DateTime.UtcNow < deadline)
        {
            if (!Mutex.TryOpenExisting(names.Helper, out var helper)) return true;
            using (helper)
            {
                Set(names.Stop);
                try
                {
                    var wait = TimeSpan.FromMilliseconds(Math.Clamp((deadline - DateTime.UtcNow).TotalMilliseconds, 0, 1000));
                    if (helper.WaitOne(wait))
                    {
                        helper.ReleaseMutex();
                        return true;
                    }
                }
                catch (AbandonedMutexException)
                {
                    helper.ReleaseMutex();
                    return true;
                }
            }
        }
        return !Exists(names.Helper);
    }
}
