using Vystral.Core.Matching;
using Xunit;

namespace Vystral.Tests.Core;

public sealed class TitleNormalizerTests
{
    private static string Base(string title) => TitleNormalizer.Normalize(title).Base;
    private static string Full(string title) => TitleNormalizer.Normalize(title).Full;

    [Theory]
    [InlineData("Halo™ Infinite", "halo infinite")]
    [InlineData("Assassin's Creed® Valhalla", "assassin s creed valhalla")]
    [InlineData("Tom Clancy's Rainbow Six® Siege", "tom clancy s rainbow six siege")]
    [InlineData("STAR WARS™ Jedi: Fallen Order™", "star wars jedi fallen order")]
    [InlineData("Minecraft©", "minecraft")]
    public void Strips_trademark_symbols_and_punctuation(string title, string expected) =>
        Assert.Equal(expected, Base(title));

    [Theory]
    [InlineData("Pokémon", "Pokemon")]
    [InlineData("Ōkami HD", "Okami HD")]
    [InlineData("Brütal Légend", "Brutal Legend")]
    [InlineData("Señor Café", "Senor Cafe")]
    public void Folds_diacritics(string accented, string plain) =>
        Assert.Equal(Full(plain), Full(accented));

    [Fact]
    public void Curly_apostrophes_and_dashes_are_equivalent_to_ascii()
    {
        Assert.Equal(Full("Assassin's Creed - Origins"), Full("Assassin’s Creed — Origins"));
        Assert.Equal(Full("Assassin's Creed - Origins"), Full("Assassin's Creed – Origins"));
    }

    [Fact]
    public void Ampersand_equals_and()
    {
        Assert.Equal("ratchet and clank", Base("Ratchet & Clank"));
        Assert.Equal(Full("Ratchet and Clank"), Full("Ratchet & Clank"));
    }

    [Theory]
    [InlineData("Final Fantasy VII", "final fantasy 7")]
    [InlineData("Grand Theft Auto V", "grand theft auto 5")]
    [InlineData("Civilization VI", "civilization 6")]
    [InlineData("Age of Empires II", "age of empires 2")]
    [InlineData("Final Fantasy XIV Online", "final fantasy 14 online")]
    [InlineData("Dragon Quest XI", "dragon quest 11")]
    public void Roman_numerals_become_digits(string title, string expected)
    {
        Assert.Equal(expected, Base(title));
        Assert.Equal(Base(expected), Base(title));
    }

    [Fact]
    public void Roman_numerals_are_only_replaced_as_whole_words()
    {
        Assert.Equal("vivid knight", Base("Vivid Knight"));
        Assert.Equal("civilization", Base("Civilization"));
        Assert.Equal("vixen", Base("Vixen"));
        Assert.Equal("13 century", Base("XIII Century"));
    }

    [Fact]
    public void Leading_the_is_ignored_for_matching()
    {
        Assert.Equal(Full("Witcher 3: Wild Hunt"), Full("The Witcher 3: Wild Hunt"));
        Assert.Equal("witcher 3 wild hunt", Base("The Witcher® 3: Wild Hunt™"));
    }

    [Fact]
    public void The_alone_or_mid_title_is_kept()
    {
        Assert.Equal("the", Base("The"));
        Assert.Equal("lord of the rings", Base("Lord of the Rings"));
        Assert.Equal("theme hospital", Base("Theme Hospital"));
    }

    [Theory]
    [InlineData("The Witcher 3: Wild Hunt - Game of the Year Edition")]
    [InlineData("The Witcher 3: Wild Hunt Game of the Year")]
    [InlineData("The Witcher 3: Wild Hunt GOTY")]
    [InlineData("The Witcher 3: Wild Hunt – GOTY Edition")]
    public void Game_of_the_year_variants_canonicalize_to_goty(string title)
    {
        var n = TitleNormalizer.Normalize(title);
        Assert.Equal("witcher 3 wild hunt", n.Base);
        Assert.Equal(["goty"], n.EditionTokens.ToArray());
        Assert.Equal("witcher 3 wild hunt [goty]", n.Full);
    }

    [Fact]
    public void All_goty_variants_have_identical_full_keys()
    {
        var keys = new[]
        {
            "Batman: Arkham City - Game of the Year Edition",
            "Batman: Arkham City GOTY",
            "Batman™: Arkham City Game of the Year",
            "Batman: Arkham City GOTY Edition",
        }.Select(Full).Distinct().ToList();
        Assert.Single(keys);
    }

    [Theory]
    [InlineData("Age of Empires II: Definitive Edition", "age of empires 2", "definitive")]
    [InlineData("Skyrim Special Edition", "skyrim", "special")]
    [InlineData("Red Dead Redemption 2: Ultimate Edition", "red dead redemption 2", "ultimate")]
    [InlineData("Fallout 4: Game of the Year Edition", "fallout 4", "goty")]
    [InlineData("Death Stranding Director's Cut", "death stranding", "directors-cut")]
    [InlineData("Death Stranding Directors Cut", "death stranding", "directors-cut")]
    [InlineData("Divinity: Original Sin 2 - Definitive Edition", "divinity original sin 2", "definitive")]
    [InlineData("Cyberpunk 2077 Collectors Edition", "cyberpunk 2077", "collectors")]
    public void Edition_qualifiers_are_moved_to_tokens(string title, string expectedBase, string token)
    {
        var n = TitleNormalizer.Normalize(title);
        Assert.Equal(expectedBase, n.Base);
        Assert.Contains(token, n.EditionTokens);
    }

    [Fact]
    public void Digital_deluxe_edition_is_one_token_and_not_left_in_the_base()
    {
        // Regression: "deluxe edition" used to be matched first, leaving "digital" in the base title.
        var n = TitleNormalizer.Normalize("Forza Horizon 5 Digital Deluxe Edition");
        Assert.Equal("forza horizon 5", n.Base);
        Assert.Equal(["digital-deluxe"], n.EditionTokens.ToArray());
        Assert.Equal(Base("Forza Horizon 5"), n.Base);
        Assert.NotEqual(Full("Forza Horizon 5 Deluxe Edition"), n.Full);
    }

    [Fact]
    public void Different_editions_share_base_but_not_full()
    {
        var a = TitleNormalizer.Normalize("Skyrim");
        var b = TitleNormalizer.Normalize("Skyrim Special Edition");
        Assert.Equal(a.Base, b.Base);
        Assert.NotEqual(a.Full, b.Full);
        Assert.Empty(a.EditionTokens);
        Assert.Equal("skyrim", a.Full);
    }

    [Fact]
    public void Multiple_edition_tokens_are_sorted_in_Full()
    {
        var n = TitleNormalizer.Normalize("Game Ultimate Edition Director's Cut");
        Assert.Equal("game", n.Base);
        Assert.Equal("game [directors-cut ultimate]", n.Full);
    }

    [Theory]
    [InlineData("Forza Horizon 5 (PC)")]
    [InlineData("Forza Horizon 5 (Windows)")]
    [InlineData("Forza Horizon 5 - Windows")]
    [InlineData("Forza Horizon 5 for Windows 10")]
    [InlineData("Forza Horizon 5 for Windows")]
    [InlineData("Forza Horizon 5 PC Edition")]
    [InlineData("Forza Horizon 5 Windows Edition")]
    [InlineData("Forza Horizon 5 Steam Edition")]
    [InlineData("Forza Horizon 5 Epic Edition")]
    [InlineData("Forza Horizon 5 Xbox Edition")]
    public void Platform_qualifiers_are_ignored_entirely(string title)
    {
        var n = TitleNormalizer.Normalize(title);
        Assert.Equal("forza horizon 5", n.Base);
        Assert.Empty(n.EditionTokens);
        Assert.Equal(Full("Forza Horizon 5"), n.Full);
    }

    [Theory]
    [InlineData("Dark Souls Remastered", "Dark Souls")]
    [InlineData("Resident Evil 2 Remake", "Resident Evil 2")]
    [InlineData("Shadow of the Colossus Remake", "Shadow of the Colossus")]
    [InlineData("Age of Empires II: Definitive Edition", "Age of Empires III: Definitive Edition")]
    [InlineData("Half-Life 2", "Half-Life")]
    [InlineData("Halo: Reach", "Halo")]
    [InlineData("Mafia II Redux", "Mafia II")]
    public void Remasters_remakes_sequels_and_subtitles_are_not_stripped(string a, string b) =>
        Assert.NotEqual(Base(a), Base(b));

    [Fact]
    public void Remastered_stays_in_base()
    {
        Assert.Equal("dark souls remastered", Base("DARK SOULS™: REMASTERED"));
    }

    [Fact]
    public void Edition_phrases_inside_words_are_not_stripped()
    {
        Assert.Equal("gotyland", Base("Gotyland"));
        Assert.Empty(TitleNormalizer.Normalize("Gotyland").EditionTokens);
        Assert.Equal("windowsill simulator", Base("Windowsill Simulator"));
    }

    [Fact]
    public void Case_and_whitespace_do_not_matter()
    {
        Assert.Equal(Full("hollow knight"), Full("  HOLLOW   KNIGHT  "));
        Assert.Equal(Full("Hollow Knight"), Full("Hollow\tKnight"));
    }

    [Fact]
    public void Original_title_is_preserved()
    {
        Assert.Equal("The Witcher® 3", TitleNormalizer.Normalize("The Witcher® 3").Original);
    }

    [Fact]
    public void Title_of_only_symbols_normalizes_to_empty_base()
    {
        Assert.Equal("", Base("™®"));
        Assert.Equal("", Base("!!!"));
    }

    [Theory]
    [InlineData("The Last of Us", "last of us")]
    [InlineData("A Plague Tale: Innocence", "plague tale: innocence")]
    [InlineData("An Untitled Story", "untitled story")]
    [InlineData("the witcher", "witcher")]
    [InlineData("Theme Hospital", "theme hospital")]
    [InlineData("Anno 1800", "anno 1800")]
    [InlineData("Alan Wake", "alan wake")]
    [InlineData("The", "the")]
    [InlineData("Élite Dangerous™", "elite dangerous")]
    [InlineData("  The Crew®  ", "crew")]
    public void SortKey_ignores_articles_case_diacritics_and_trademarks(string title, string expected) =>
        Assert.Equal(expected, TitleNormalizer.SortKey(title));

    [Fact]
    public void SortKey_orders_titles_alphabetically_ignoring_articles()
    {
        var titles = new[] { "The Witcher 3", "Alan Wake", "A Hat in Time", "Celeste", "The Banner Saga" };
        var sorted = titles.OrderBy(TitleNormalizer.SortKey, StringComparer.Ordinal).ToArray();
        Assert.Equal(new[] { "Alan Wake", "The Banner Saga", "Celeste", "A Hat in Time", "The Witcher 3" }, sorted);
    }

    [Theory]
    [InlineData("Halo™  Infinite", "Halo Infinite")]
    [InlineData("  DOOM®   Eternal ", "DOOM Eternal")]
    [InlineData("Game Name", "Game Name")]
    [InlineData("Pokémon", "Pokémon")]
    public void CleanDisplayTitle_removes_glyphs_and_odd_spacing_but_keeps_text(string title, string expected) =>
        Assert.Equal(expected, TitleNormalizer.CleanDisplayTitle(title));
}
