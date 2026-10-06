using System.Text.Json;
using Vystral.Windows.Services;
using Xunit;

namespace Vystral.Tests.Shell;

public class ActivationUriTests
{
    private const string Id = "0123456789abcdef0123456789abcdef";

    private static Dictionary<string, string>? Parse(string? uri) =>
        ActivationUri.RouteFromUri(uri) is { } json ? JsonSerializer.Deserialize<Dictionary<string, string>>(json) : null;

    [Theory]
    [InlineData("vystral://open?route=home", "home")]
    [InlineData("vystral://open/?route=journal", "journal")]
    [InlineData("VYSTRAL://OPEN?route=library", "library")]
    [InlineData("vystral://open?route=storage", "storage")]
    [InlineData("vystral://open?route=health", "health")]
    public void Accepts_known_routes(string uri, string name)
    {
        var r = Parse(uri)!;
        Assert.Equal(name, r["name"]);
        Assert.Single(r);
    }

    [Fact]
    public void Accepts_route_parameters_in_the_right_place()
    {
        Assert.Equal(Id, Parse($"vystral://open?route=game&id={Id}")!["id"]);
        Assert.Equal(Id, Parse($"vystral://open?route=performance&sessionId={Id}")!["sessionId"]);
        Assert.Equal("updates", Parse("vystral://open?route=settings&section=updates")!["section"]);
        Assert.Equal("performance", Parse("vystral://open?route=performance")!["name"]);
        Assert.Equal("achievements", Parse("vystral://open?route=journal&tab=achievements")!["tab"]);
    }

    [Theory]
    [InlineData("vystral://open?route=journal&tab=settings")]
    [InlineData("vystral://open?route=game&tab=achievements")]
    [InlineData("vystral://open?route=journal&tab=Achievements")]
    public void Journal_tab_is_limited_to_its_two_tabs(string uri) => Assert.Null(Parse(uri));

    [Fact]
    public void Achievement_notifications_build_a_clickable_link() =>
        Assert.NotNull(ActivationUri.Build(NotificationPolicy.Route("journal", ("tab", "achievements"))));

    [Theory]
    [InlineData(null)]
    [InlineData("")]
    [InlineData("vystral://open")]
    [InlineData("vystral://open?")]
    [InlineData("vystral://open?route=")]
    [InlineData("vystral://open?route=admin")]                        // unknown route
    [InlineData("vystral://open?route=moments")]                      // real UI route, but not openable from outside
    [InlineData("vystral://open?route=Home")]                         // case matters for route names
    [InlineData("vystral://launch?route=home")]                       // only the "open" action exists
    [InlineData("vystral://open.evil?route=home")]
    [InlineData("vystral://open@evil?route=home")]
    [InlineData("vystral://open:80?route=home")]
    [InlineData("vystral:open?route=home")]
    [InlineData("https://open?route=home")]
    [InlineData("vystral://open?route=home#x")]
    [InlineData("vystral://open?route=home&route=game")]              // duplicates
    [InlineData("vystral://open?route=home&id=0123456789abcdef0123456789abcdef")] // parameter on wrong route
    [InlineData("vystral://open?route=home&foo=bar")]                 // unknown parameter
    [InlineData("vystral://open?route=home&")]
    [InlineData("vystral://open?route=home&=x")]
    [InlineData("vystral://open?route")]
    [InlineData("vystral://open?route=game")]                         // game needs an id
    [InlineData("vystral://open?route=game&id=abc")]                  // not an id
    [InlineData("vystral://open?route=game&id=0123456789ABCDEF0123456789ABCDEF")] // ids are lowercase hex
    [InlineData("vystral://open?route=game&id=..%2F..%2Fwindows")]    // path traversal / escapes
    [InlineData("vystral://open?route=game&id=../../../../etc/passwd")]
    [InlineData("vystral://open?route=settings&section=..")]
    [InlineData("vystral://open?route=settings&section=%2e%2e")]
    [InlineData("vystral://open?route=settings&section=<script>")]
    [InlineData("vystral://open?route=settings&section=javascript:alert(1)")]
    [InlineData("vystral://open?route=settings&section=a\"b")]
    [InlineData("vystral://open?route=home\" --safe-mode \"")]         // command-line injection attempt
    [InlineData("vystral://open?route=home%00")]
    [InlineData("vystral://open?route=h%6Fme")]                       // no percent-escapes at all
    [InlineData("vystral://open?route=home\n")]
    [InlineData("vystral://open?route=home\t")]
    [InlineData("vystral://open?route=hоme")]                         // Cyrillic о
    [InlineData("vystral://open?route=settings&section=ünicode")]
    [InlineData("vystral://open?route=home&section=updates")]
    [InlineData(" vystral://open?route=home")]
    public void Rejects_anything_unexpected(string? uri) => Assert.Null(ActivationUri.RouteFromUri(uri));

    [Fact]
    public void Rejects_overlong_input()
    {
        Assert.Null(ActivationUri.RouteFromUri("vystral://open?route=home&x=" + new string('a', 600)));
        Assert.Null(ActivationUri.RouteFromUri("vystral://open?route=settings&section=" + new string('a', 25)));
    }

    [Fact]
    public void Rejects_trailing_newline_after_an_id_from_activation_arguments()
    {
        // Regex '$' would accept "id\n"; the validator anchors with \z.
        Assert.Null(ActivationUri.RouteFromArguments(new Dictionary<string, string> { ["route"] = "game", ["id"] = Id + "\n" }));
        Assert.NotNull(ActivationUri.RouteFromArguments(new Dictionary<string, string> { ["route"] = "game", ["id"] = Id }));
    }

    [Fact]
    public void Fuzzed_inputs_never_throw_and_only_yield_allow_listed_routes()
    {
        var rng = new Random(1234);
        const string alphabet = "abcdefghijklmnopqrstuvwxyz0123456789=&?/:%#.-_\"' <>\\\u00e9\u202e\0";
        string[] seeds = ["vystral://open?route=", "vystral://open?route=game&id=", "vystral://open?route=settings&section=", ""];
        for (var i = 0; i < 5000; i++)
        {
            var len = rng.Next(0, 80);
            var chars = new char[len];
            for (var j = 0; j < len; j++) chars[j] = alphabet[rng.Next(alphabet.Length)];
            var uri = seeds[rng.Next(seeds.Length)] + new string(chars);
            var json = ActivationUri.RouteFromUri(uri);
            if (json is null) continue;
            var r = JsonSerializer.Deserialize<Dictionary<string, string>>(json)!;
            Assert.Contains(r["name"], ActivationUri.RouteNames);
            Assert.All(r.Values, v => Assert.Matches("^[a-z0-9]{1,32}$", v));
        }
    }

    [Theory]
    [InlineData("{\"name\":\"journal\"}", "vystral://open?route=journal")]
    [InlineData("{\"name\":\"settings\",\"section\":\"updates\"}", "vystral://open?route=settings&section=updates")]
    [InlineData("{\"name\":\"game\",\"id\":\"0123456789abcdef0123456789abcdef\"}", "vystral://open?route=game&id=0123456789abcdef0123456789abcdef")]
    public void Builds_uris_that_round_trip(string routeJson, string expected)
    {
        var uri = ActivationUri.Build(routeJson);
        Assert.Equal(expected, uri);
        Assert.Equal(JsonSerializer.Deserialize<Dictionary<string, string>>(routeJson), Parse(uri));
    }

    [Theory]
    [InlineData("{\"name\":\"admin\"}")]
    [InlineData("{\"name\":\"game\",\"id\":\"../x\"}")]
    [InlineData("{\"name\":\"home\",\"extra\":\"1\"}")]
    [InlineData("{\"name\":1}")]
    [InlineData("[]")]
    [InlineData("not json")]
    public void Build_refuses_routes_it_could_not_parse_back(string routeJson) => Assert.Null(ActivationUri.Build(routeJson));

    [Fact]
    public void Notification_policy_routes_are_all_buildable()
    {
        Assert.NotNull(ActivationUri.Build(NotificationPolicy.Route("journal")));
        Assert.NotNull(ActivationUri.Build(NotificationPolicy.Route("library")));
        Assert.NotNull(ActivationUri.Build(NotificationPolicy.Route("game", ("id", Id))));
        Assert.NotNull(ActivationUri.Build(NotificationPolicy.Route("performance", ("sessionId", Id))));
        Assert.NotNull(ActivationUri.Build(NotificationPolicy.Route("settings", ("section", "updates"))));
        Assert.NotNull(ActivationUri.Build(NotificationPolicy.Route("settings", ("section", "windows"))));
    }

    [Fact]
    public void Command_line_must_be_exactly_the_registered_shape()
    {
        Assert.Equal("vystral://open?route=home", ActivationUri.FromArgs(["--uri", "vystral://open?route=home"]));
        Assert.Null(ActivationUri.FromArgs(["--uri"]));
        Assert.Null(ActivationUri.FromArgs(["--uri", "vystral://open?route=home", "--safe-mode"]));
        Assert.Null(ActivationUri.FromArgs(["--safe-mode", "--uri", "vystral://open?route=home"]));
        Assert.Null(ActivationUri.FromArgs(["--URI", "vystral://open?route=home"]));
        Assert.Null(ActivationUri.FromArgs([]));
    }

    [Theory]
    [InlineData("\"C:\\Users\\a b\\Vystral.exe\" --uri \"vystral://open?route=home\"", "vystral://open?route=home")]
    [InlineData("--uri \"vystral://open?route=home\"", "vystral://open?route=home")]
    [InlineData("--uri vystral://open?route=home", "vystral://open?route=home")]
    [InlineData("C:\\Vystral.exe --uri vystral://open?route=home", "vystral://open?route=home")]
    public void Reads_redirected_command_lines(string commandLine, string expected) =>
        Assert.Equal(expected, ActivationUri.FromCommandLine(commandLine));

    [Theory]
    [InlineData("\"C:\\Vystral.exe\"")]
    [InlineData("\"C:\\Vystral.exe\" --safe-mode")]
    [InlineData("\"C:\\Vystral.exe\" --uri \"vystral://open?route=home\" --safe-mode \"\"")] // quote-injected extra args
    [InlineData("\"C:\\Vystral.exe\" --other \"vystral://open?route=home\"")]
    [InlineData("")]
    [InlineData(null)]
    public void Ignores_other_command_lines(string? commandLine) => Assert.Null(ActivationUri.FromCommandLine(commandLine));
}
