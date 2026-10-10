using Vystral.Windows.Integrations;
using Vystral.Windows.Services;
using Xunit;

namespace Vystral.Tests.TrackD2;

/// <summary>Track D2: release-date precision for the wishlist calendar, from Steam's real shapes.</summary>
public sealed class WishlistReleaseTests
{
    private static DateTimeOffset At(long unix) => DateTimeOffset.FromUnixTimeSeconds(unix);

    [Theory]
    // Plain years, with Steam's and publishers' filler words.
    [InlineData("2027", "year", "2027-01-01", "2027-12-31")]
    [InlineData("Coming 2027", "year", "2027-01-01", "2027-12-31")]
    [InlineData("Coming in 2027!", "year", "2027-01-01", "2027-12-31")]
    [InlineData("2027 (PC)", "year", "2027-01-01", "2027-12-31")]
    [InlineData("Release date: 2027", "year", "2027-01-01", "2027-12-31")]
    [InlineData("Early Access 2027", "year", "2027-01-01", "2027-12-31")]
    // Quarters in every spelling Steam pages use.
    [InlineData("Q1 2027", "quarter", "2027-01-01", "2027-03-31")]
    [InlineData("Q1, 2027", "quarter", "2027-01-01", "2027-03-31")]
    [InlineData("q3 2026", "quarter", "2026-07-01", "2026-09-30")]
    [InlineData("Q2 '27", "quarter", "2027-04-01", "2027-06-30")]
    [InlineData("4Q 2026", "quarter", "2026-10-01", "2026-12-31")]
    [InlineData("2027 Q4", "quarter", "2027-10-01", "2027-12-31")]
    [InlineData("First quarter of 2027", "quarter", "2027-01-01", "2027-03-31")]
    [InlineData("Coming Q2 2027™", "quarter", "2027-04-01", "2027-06-30")]
    // Halves.
    [InlineData("H1 2027", "half", "2027-01-01", "2027-06-30")]
    [InlineData("Second half of 2026", "half", "2026-07-01", "2026-12-31")]
    [InlineData("2027 H2", "half", "2027-07-01", "2027-12-31")]
    // Seasons and parts of a year.
    [InlineData("Summer 2027", "season", "2027-06-01", "2027-08-31")]
    [InlineData("Spring, 2027", "season", "2027-03-01", "2027-05-31")]
    [InlineData("Fall '26", "season", "2026-09-01", "2026-11-30")]
    [InlineData("Autumn 2026", "season", "2026-09-01", "2026-11-30")]
    [InlineData("Late Summer 2027", "season", "2027-06-01", "2027-08-31")]
    [InlineData("Holiday 2026", "season", "2026-11-01", "2026-12-31")]
    [InlineData("Winter 2026", "season", "2026-01-01", "2027-02-28")]
    [InlineData("Early 2027", "season", "2027-01-01", "2027-04-30")]
    [InlineData("Mid-2027", "season", "2027-05-01", "2027-08-31")]
    [InlineData("Late 2026", "season", "2026-09-01", "2026-12-31")]
    [InlineData("End of 2026", "season", "2026-09-01", "2026-12-31")]
    // Months.
    [InlineData("February 2027", "month", "2027-02-01", "2027-02-28")]
    [InlineData("Feb. 2027", "month", "2027-02-01", "2027-02-28")]
    [InlineData("Sept 2026", "month", "2026-09-01", "2026-09-30")]
    [InlineData("Coming March, 2028", "month", "2028-03-01", "2028-03-31")]
    // A full date in the free text.
    [InlineData("15 Jan, 2027", "day", "2027-01-15", "2027-01-15")]
    [InlineData("March 15th, 2027", "day", "2027-03-15", "2027-03-15")]
    [InlineData("2027-03-15", "day", "2027-03-15", "2027-03-15")]
    public void Free_text_dates_keep_the_precision_they_really_have(string text, string precision, string from, string to)
    {
        var w = WishlistRelease.FromText(text)!;
        Assert.Equal(precision, w.Precision);
        Assert.Equal(DateOnly.Parse(from), w.From);
        Assert.Equal(DateOnly.Parse(to), w.To);
    }

    [Theory]
    [InlineData("To be announced")]
    [InlineData("TBA")]
    [InlineData("TBD")]
    [InlineData("Coming soon")]
    [InlineData("Coming Soon™")]
    [InlineData("When it's done")]
    [InlineData("Q1/Q2 2027")]          // ambiguous: never a guessed window
    [InlineData("03/04/2027")]          // day/month order unknown
    [InlineData("FY2027")]
    [InlineData("Q5 2027")]
    [InlineData("Summer 1850")]
    public void Unreadable_or_ambiguous_text_is_tba_and_keeps_its_own_words(string text)
    {
        var w = WishlistRelease.FromText(text)!;
        Assert.Equal("tba", w.Precision);
        Assert.Null(w.From);
        Assert.Equal(text, w.Label);
    }

    [Fact]
    public void Empty_text_is_nothing_and_control_characters_are_removed()
    {
        Assert.Null(WishlistRelease.FromText(null));
        Assert.Null(WishlistRelease.FromText("   "));
        Assert.Equal("Q1 2027", WishlistRelease.FromText("Q1‮ 2027\u0007")!.Label);
    }

    [Fact]
    public void Steam_display_modes_decide_the_precision()
    {
        // Real values from the owner's wishlist (see Fixtures/TrackD2/storeitems_owner.json).
        var ill = WishlistRelease.Parse(null, At(1830240000), true, "date_year", "2027");                 // ILL
        Assert.Equal(("year", new DateOnly(2027, 1, 1), new DateOnly(2027, 12, 31), "2027"), (ill.Precision, ill.From, ill.To, ill.Label));
        var fable = WishlistRelease.Parse(At(1803398400), At(1803398400), true, "date_full", null);     // Fable
        Assert.Equal(("day", new DateOnly(2027, 2, 23)), (fable.Precision, fable.From));
        Assert.Null(fable.Label);
        var sod3 = WishlistRelease.Parse(null, null, true, "text_tba", "To be announced");               // State of Decay 3
        Assert.Equal(("tba", "To be announced"), (sod3.Precision, sod3.Label));
        var wick = WishlistRelease.Parse(null, null, true, "text_comingsoon", "Coming soon");            // Untitled John Wick Game
        Assert.Equal(("tba", "Coming soon"), (wick.Precision, wick.Label));
        var bus = WishlistRelease.Parse(At(1788880089), At(1788880089), false, null, null);              // Bus Simulator 27, out
        Assert.Equal(("day", new DateOnly(2026, 9, 8)), (bus.Precision, bus.From));

        var month = WishlistRelease.Parse(null, new DateTimeOffset(2027, 3, 31, 7, 0, 0, TimeSpan.Zero), true, "date_month", "March 2027");
        Assert.Equal(("month", new DateOnly(2027, 3, 1), new DateOnly(2027, 3, 31), "March 2027"), (month.Precision, month.From, month.To, month.Label));
        var quarter = WishlistRelease.Parse(null, new DateTimeOffset(2026, 1, 1, 0, 0, 0, TimeSpan.Zero), true, "date_quarter", null);
        Assert.Equal(("quarter", "Q1 2026"), (quarter.Precision, quarter.Label));
    }

    [Fact]
    public void Publisher_text_wins_over_a_bare_display_mode_and_nothing_is_ever_a_fake_day()
    {
        Assert.Equal("quarter", WishlistRelease.Parse(null, null, true, "text_tba", "Q3 2027").Precision);
        Assert.Equal(("tba", "To be announced"), Pick(WishlistRelease.Parse(null, null, true, "text_tba", null)));
        Assert.Equal(("tba", "Coming soon"), Pick(WishlistRelease.Parse(null, null, true, "text_comingsoon", null)));
        Assert.Equal(("tba", "To be announced"), Pick(WishlistRelease.Parse(null, null, true, "date_full", null)));   // a full date without a date
        Assert.Equal("day", WishlistRelease.Parse(At(1803398400), null, true, null, null).Precision);            // older answers: no display mode
        Assert.Equal(("tba", "Out now"), Pick(WishlistRelease.Parse(null, null, false, null, null)));               // released, Steam gives no date
        static (string, string?) Pick(ReleaseWindow w) => (w.Precision, w.Label);
    }

    [Fact]
    public void The_owner_fixture_parses_to_honest_windows()
    {
        var ids = new[] { "1340720", "1757350", "2358720", "2397320", "2439280", "2487330", "2590240", "2638890", "2769570", "2947860", "3010850",
            "3061930", "3080520", "3558670", "3596430", "3669870", "4096880", "4115450", "4260840", "4814120", "4824610", "5006530" };
        var items = SteamWebApiClient.ParseStoreItems(WishlistArtTests.Fixture("storeitems_owner.json"), ids).ToDictionary(i => i.AppId);
        Assert.Equal(22, items.Count);
        ReleaseWindow W(string id) { var i = items[id]; return WishlistRelease.Parse(i.ReleaseDate, i.ReleaseHint, i.ComingSoon, i.ReleaseDisplay, i.ReleaseText); }

        var precisions = ids.GroupBy(id => W(id).Precision).ToDictionary(g => g.Key, g => g.Count());
        Assert.Equal(11, precisions["day"]);   // 5 out already, 6 with a full date
        Assert.Equal(4, precisions["year"]);   // ILL, Clockwork Revolution, CLUTCH, Resident Evil Veronica: "2027"
        Assert.Equal(7, precisions["tba"]);    // four "To be announced", three "Coming soon"
        Assert.Equal(3, precisions.Count);
        Assert.Equal("2027", W("3061930").Label);
        Assert.Equal("To be announced", W("3596430").Label);                                // Bancho the Chef
        Assert.Equal(new DateOnly(2027, 1, 15), W("4814120").From);                         // ANANTA
        Assert.Null(items["1757350"].ReleaseDate);                                          // a year is never a day
    }
}
