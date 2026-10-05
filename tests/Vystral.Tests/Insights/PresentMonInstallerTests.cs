using System.Net;
using System.Security.Cryptography;
using Vystral.Tests.Support;
using Vystral.Windows.Monitoring;
using Xunit;

namespace Vystral.Tests.Insights;

public sealed class PresentMonInstallerTests
{
    private sealed class FakeHandler(Func<HttpRequestMessage, HttpResponseMessage> respond) : HttpMessageHandler
    {
        public List<Uri> Requests { get; } = [];
        protected override Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken ct)
        {
            Requests.Add(request.RequestUri!);
            var r = respond(request);
            r.RequestMessage ??= request;
            return Task.FromResult(r);
        }
    }

    private static readonly byte[] Payload = Enumerable.Range(0, 200_000).Select(i => (byte)(i * 31)).ToArray();
    private static string Hash(byte[] b) => Convert.ToHexStringLower(SHA256.HashData(b));

    private static PresentMonRelease Release(string sha) =>
        new("9.9.9", "PresentMon-test.exe", new Uri("https://github.com/GameTechDev/PresentMon/releases/download/v9.9.9/PresentMon-test.exe"), Payload.Length, sha);

    private static HttpResponseMessage Ok(byte[] body) => new(HttpStatusCode.OK) { Content = new ByteArrayContent(body) };

    [Fact]
    public async Task Matching_download_is_installed_and_verified()
    {
        using var dir = new TempDir();
        var handler = new FakeHandler(_ => Ok(Payload));
        using var http = new HttpClient(handler);
        var installer = new PresentMonInstaller(dir.Path, http, Release(Hash(Payload)));
        var progress = new List<double>();

        Assert.False(installer.IsInstalled());
        await installer.InstallAsync(new SyncProgress(progress.Add), CancellationToken.None);

        Assert.True(installer.IsInstalled());
        Assert.Equal(Payload, File.ReadAllBytes(installer.ExePath));
        Assert.Single(handler.Requests);
        Assert.Equal("https", handler.Requests[0].Scheme);
        Assert.NotEmpty(progress);
        Assert.Equal(1, progress[^1], 0.001);
        Assert.False(File.Exists(installer.ExePath + ".download"));
    }

    [Fact]
    public async Task Hash_mismatch_is_rejected_and_nothing_is_left_behind()
    {
        using var dir = new TempDir();
        var tampered = Payload.ToArray();
        tampered[1234] ^= 0xFF;
        using var http = new HttpClient(new FakeHandler(_ => Ok(tampered)));
        var installer = new PresentMonInstaller(dir.Path, http, Release(Hash(Payload)));

        var ex = await Assert.ThrowsAsync<InvalidDataException>(() => installer.InstallAsync(null, CancellationToken.None));
        Assert.Contains("SHA-256", ex.Message);
        Assert.False(File.Exists(installer.ExePath));
        Assert.Empty(Directory.GetFiles(dir.Path));
    }

    [Fact]
    public async Task A_previously_installed_file_that_was_modified_is_not_trusted()
    {
        using var dir = new TempDir();
        using var http = new HttpClient(new FakeHandler(_ => Ok(Payload)));
        var installer = new PresentMonInstaller(dir.Path, http, Release(Hash(Payload)));
        await installer.InstallAsync(null, CancellationToken.None);
        File.AppendAllText(installer.ExePath, "x");
        Assert.False(installer.IsInstalled());
        installer.Uninstall();
        Assert.False(File.Exists(installer.ExePath));
    }

    [Fact]
    public async Task Oversized_and_failed_downloads_are_refused()
    {
        using var dir = new TempDir();
        var huge = new byte[17 * 1024 * 1024];
        using (var http = new HttpClient(new FakeHandler(_ => Ok(huge))))
        {
            var installer = new PresentMonInstaller(dir.Path, http, Release(Hash(huge)));
            await Assert.ThrowsAsync<InvalidDataException>(() => installer.InstallAsync(null, CancellationToken.None));
            Assert.False(File.Exists(installer.ExePath));
        }
        using (var http = new HttpClient(new FakeHandler(_ => new HttpResponseMessage(HttpStatusCode.NotFound))))
        {
            var installer = new PresentMonInstaller(dir.Path, http, Release(Hash(Payload)));
            await Assert.ThrowsAsync<HttpRequestException>(() => installer.InstallAsync(null, CancellationToken.None));
        }
    }

    [Fact]
    public async Task Redirect_to_an_insecure_address_is_refused()
    {
        using var dir = new TempDir();
        using var http = new HttpClient(new FakeHandler(_ => new HttpResponseMessage(HttpStatusCode.OK)
        {
            Content = new ByteArrayContent(Payload),
            RequestMessage = new HttpRequestMessage(HttpMethod.Get, "http://example.invalid/PresentMon.exe"),
        }));
        var installer = new PresentMonInstaller(dir.Path, http, Release(Hash(Payload)));
        await Assert.ThrowsAsync<InvalidDataException>(() => installer.InstallAsync(null, CancellationToken.None));
        Assert.False(File.Exists(installer.ExePath));
    }

    [Fact]
    public void Pinned_release_is_the_official_https_asset()
    {
        var r = PresentMonRelease.Pinned;
        Assert.Equal("2.6.0", r.Version);
        Assert.Equal("https", r.Url.Scheme);
        Assert.Equal("github.com", r.Url.Host);
        Assert.StartsWith("/GameTechDev/PresentMon/releases/download/", r.Url.AbsolutePath);
        Assert.Matches("^[0-9a-f]{64}$", r.Sha256);
        Assert.Equal("b2a706bc6ad475749e3b7e3409263aa1e6906d45bdcf993f6dbc0f660188f1af", r.Sha256);
        Assert.Equal(980_320, r.SizeBytes);
    }

    [Fact]
    public void Group_add_arguments_reject_injection()
    {
        Assert.Equal(["localgroup", "Performance Log Users", @"PC\me", "/add"], PresentMonInstaller.GroupAddArguments("Performance Log Users", @"PC\me"));
        Assert.Throws<ArgumentException>(() => PresentMonInstaller.GroupAddArguments("Performance Log Users", "me\" /delete \"x"));
        Assert.Throws<ArgumentException>(() => PresentMonInstaller.GroupAddArguments("", @"PC\me"));
        Assert.Throws<ArgumentException>(() => PresentMonInstaller.GroupAddArguments("Group", "a\nb"));
    }

    private sealed class SyncProgress(Action<double> report) : IProgress<double>
    {
        public void Report(double value) => report(value);
    }
}
