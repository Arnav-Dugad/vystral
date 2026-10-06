using System.Net;
using Vystral.Core.Domain;
using Vystral.Tests.SteamAccount;
using Vystral.Tests.Support;
using Vystral.Windows;
using Vystral.Windows.Bridge;
using Vystral.Windows.DataSources;
using Vystral.Windows.Services;
using Xunit;

namespace Vystral.Tests.Services;

/// <summary>
/// Background work that must not run twice, run on, or hang: one update download at a time, cover prefetch
/// that stops when a game starts, provider requests whose body stalls, and target reloads only when needed.
/// </summary>
public sealed class BackgroundWorkGuardTests : IDisposable
{
    private readonly TestDb _t = new();

    public void Dispose() => _t.Dispose();

    // ---------- Updates ----------

    [Fact]
    public void A_second_download_request_neither_restarts_nor_replaces_the_running_one()
    {
        var events = new Count();
        var updates = new UpdateService(events);

        Assert.True(updates.TryBeginDownload(out var first));
        Assert.Equal("downloading", updates.State.Phase);
        Assert.False(updates.TryBeginDownload(out _));
        Assert.Equal(1, events.Updates);

        // Cancel still reaches the download that is running.
        updates.CancelDownload();
        Assert.True(first.IsCancellationRequested);
    }

    // ---------- Cover prefetch ----------

    [Fact]
    public async Task Cover_prefetch_stops_downloading_once_a_game_starts()
    {
        _t.Repo.ApplyScan([TestDb.Ok(PlatformId.Steam,
            [.. Enumerable.Range(1, 30).Select(i => TestDb.Install(PlatformId.Steam, $"{1000 + i}", $"Game {i}", steamAppId: $"{1000 + i}"))])]);
        var requests = 0;
        var gameRunning = false;
        using var http = new HttpClient(new FakeHandler(_ =>
        {
            if (Interlocked.Increment(ref requests) >= 3) gameRunning = true; // a game starts during the run
            return new HttpResponseMessage(HttpStatusCode.NotFound);
        }));
        var art = new ArtworkService(new AppPaths(Path.Combine(_t.Dir.Path, "data")), _t.Repo, http);

        await art.PrefetchSteamCoversAsync(_t.Repo.SteamGamesMissingCover(100), () => { }, TestContext.Current.CancellationToken, () => Volatile.Read(ref gameRunning));

        // At most the downloads already in flight finish (6 at a time); the other games and the asset index wait.
        Assert.InRange(requests, 3, 3 + 6 * 2);
        Assert.True(requests < 30);
    }

    // ---------- Provider requests ----------

    [Fact]
    public async Task A_provider_answer_that_stalls_mid_body_times_out_and_frees_the_lane()
    {
        var calls = 0;
        using var http = new HttpClient(new FakeHandler(_ => Interlocked.Increment(ref calls) == 1
            ? new HttpResponseMessage(HttpStatusCode.OK) { Content = new StallingContent() }
            : new HttpResponseMessage(HttpStatusCode.OK) { Content = new StringContent("{}") }));
        var transport = new ProviderTransport(http, "test", "Test", TimeSpan.Zero) { RequestTimeout = TimeSpan.FromMilliseconds(300) };
        HttpRequestMessage Build() => new(HttpMethod.Get, "https://example.invalid/data");

        var ex = await Assert.ThrowsAsync<DataSourceException>(() => transport.SendAsync(Build, TestContext.Current.CancellationToken));
        Assert.Equal(DataSourceOutcome.Unavailable, ex.Outcome);

        // The provider's lane was released: the next request goes through.
        var next = await transport.SendAsync(Build, TestContext.Current.CancellationToken).WaitAsync(TimeSpan.FromSeconds(5), TestContext.Current.CancellationToken);
        Assert.Equal("{}", next.Body);
    }

    // ---------- Detection targets ----------

    [Theory]
    [InlineData("""{"kind":"evt","name":"library.changed","payload":{"reason":"artwork"}}""", true)]
    [InlineData("""{"kind":"evt","name":"library.changed","payload":{"reason":"metadata"}}""", true)]
    [InlineData("""{"kind":"evt","name":"library.changed","payload":{"reason":"enrichment"}}""", true)]
    [InlineData("""{"kind":"evt","name":"library.changed","payload":null}""", false)]
    [InlineData("""{"kind":"evt","name":"library.changed","payload":{"reason":"merge"}}""", false)]
    [InlineData("""{"kind":"evt","name":"library.changed","payload":{"reason":"platformScan"}}""", false)]
    [InlineData("""{"kind":"evt","name":"library.changed","payload":{"reason":"steamOwned"}}""", false)]
    [InlineData("not json", false)]
    public void Only_changes_to_which_games_exist_reload_the_detectors_targets(string eventJson, bool cosmetic) =>
        Assert.Equal(cosmetic, AppBackend.IsCosmeticLibraryChange(eventJson));

    // ---------- fakes ----------

    private sealed class Count : IEventSink
    {
        public int Updates;
        public void Emit(string eventName, object? payload)
        {
            if (eventName == "update.state") Interlocked.Increment(ref Updates);
        }
    }

    /// <summary>Headers arrive, then the body never does.</summary>
    private sealed class StallingContent : HttpContent
    {
        protected override Task SerializeToStreamAsync(Stream stream, TransportContext? context) => Task.Delay(Timeout.Infinite);
        protected override Task<Stream> CreateContentReadStreamAsync() => Task.FromResult<Stream>(new StallingStream());
        protected override bool TryComputeLength(out long length)
        {
            length = 0;
            return false;
        }
    }

    private sealed class StallingStream : Stream
    {
        public override bool CanRead => true;
        public override bool CanSeek => false;
        public override bool CanWrite => false;
        public override long Length => throw new NotSupportedException();
        public override long Position { get => 0; set => throw new NotSupportedException(); }
        public override void Flush() { }
        public override int Read(byte[] buffer, int offset, int count) => throw new NotSupportedException();
        public override async ValueTask<int> ReadAsync(Memory<byte> buffer, CancellationToken cancellationToken = default)
        {
            await Task.Delay(Timeout.Infinite, cancellationToken);
            return 0;
        }
        public override async Task<int> ReadAsync(byte[] buffer, int offset, int count, CancellationToken cancellationToken)
        {
            await Task.Delay(Timeout.Infinite, cancellationToken);
            return 0;
        }
        public override long Seek(long offset, SeekOrigin origin) => throw new NotSupportedException();
        public override void SetLength(long value) => throw new NotSupportedException();
        public override void Write(byte[] buffer, int offset, int count) => throw new NotSupportedException();
    }
}
