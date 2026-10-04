namespace Vystral.Windows.Bridge;

/// <summary>Pushes events to the UI. Implementations must be thread-safe.</summary>
public interface IEventSink
{
    void Emit(string eventName, object? payload);
}

public sealed class NullEventSink : IEventSink
{
    public static readonly NullEventSink Instance = new();
    public void Emit(string eventName, object? payload) { }
}
