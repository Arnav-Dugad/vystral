namespace Vystral.Core.Subscriptions;

/// <summary>
/// Track V: the gaming subscriptions a user can tell VYSTRAL about. The answer is stored locally only (settings
/// <c>subs.owned</c>, a comma list of these keys); VYSTRAL never checks an account. Plans in the same family
/// (one Game Pass tier, one EA Play tier, one Ubisoft+ tier) exclude each other.
/// <para>
/// Catalogue keys are the arrays of Microsoft's public <c>catalog.gamepass.com/subscriptions</c> list (verified
/// 2026-10-07, US): <c>pc</c> (687 products), <c>console</c> (614), <c>ultimate</c> (33 Ultimate extras),
/// <c>gamepassstandard</c> (786: Game Pass Premium, formerly Standard), <c>gamepasscore</c> (159: Game Pass
/// Essential, formerly Core, a subset of Premium), <c>eaaccess</c> (112: EA Play) and <c>ubisoftplus</c> (440:
/// Ubisoft+ Classics). Those IDs are Microsoft Store products, so EA Play and Ubisoft+ games bought elsewhere only
/// match by title, and are labelled as likely.
/// </para>
/// </summary>
public static class SubscriptionPlans
{
    public const string GamePassPc = "gp-pc";
    public const string GamePassEssential = "gp-essential";
    public const string GamePassPremium = "gp-premium";
    public const string GamePassUltimate = "gp-ultimate";
    public const string EaPlay = "ea-play";
    public const string EaPlayPro = "ea-play-pro";
    public const string UbisoftClassics = "ubi-classics";
    public const string UbisoftPremium = "ubi-premium";
    public const string HumbleChoice = "humble-choice";
    public const string PrimeGaming = "prime-gaming";

    public const string FamilyGamePass = "gamepass";
    public const string FamilyEa = "eaplay";
    public const string FamilyUbisoft = "ubisoft";
    public const string FamilyHumble = "humble";
    public const string FamilyPrime = "prime";

    /// <summary>Every plan, in the order the picker shows them.</summary>
    public static readonly IReadOnlyList<string> All =
    [
        GamePassPc, GamePassEssential, GamePassPremium, GamePassUltimate, EaPlay, EaPlayPro, UbisoftClassics, UbisoftPremium, HumbleChoice, PrimeGaming,
    ];

    /// <summary>The public list's keys VYSTRAL reads (anything else in the answer is ignored).</summary>
    public static readonly IReadOnlyList<string> CatalogKeys = ["pc", "console", "ultimate", "gamepassstandard", "gamepasscore", "eaaccess", "ubisoftplus"];

    public static bool IsKnown(string? key) => key is not null && All.Contains(key);

    public static string Family(string plan) => plan switch
    {
        GamePassPc or GamePassEssential or GamePassPremium or GamePassUltimate => FamilyGamePass,
        EaPlay or EaPlayPro => FamilyEa,
        UbisoftClassics or UbisoftPremium => FamilyUbisoft,
        HumbleChoice => FamilyHumble,
        _ => FamilyPrime,
    };

    public static string DisplayName(string plan) => plan switch
    {
        GamePassPc => "PC Game Pass",
        GamePassEssential => "Game Pass Essential",
        GamePassPremium => "Game Pass Premium",
        GamePassUltimate => "Game Pass Ultimate",
        EaPlay => "EA Play",
        EaPlayPro => "EA Play Pro",
        UbisoftClassics => "Ubisoft+ Classics",
        UbisoftPremium => "Ubisoft+ Premium",
        HumbleChoice => "Humble Choice",
        PrimeGaming => "Prime Gaming",
        _ => plan,
    };

    /// <summary>
    /// The public list's arrays a plan includes. PC Game Pass includes EA Play on PC; Ultimate includes the PC and
    /// console libraries, its extras, EA Play and Ubisoft+ Classics. Plans without a public list return none.
    /// Ubisoft+ Premium is a superset of Classics; only the Classics list is public, so Premium uses it.
    /// </summary>
    public static IReadOnlyList<string> CatalogKeysFor(string plan) => plan switch
    {
        GamePassPc => ["pc", "eaaccess"],
        GamePassEssential => ["gamepasscore"],
        GamePassPremium => ["gamepassstandard"],
        GamePassUltimate => ["pc", "console", "ultimate", "eaaccess", "ubisoftplus"],
        EaPlay or EaPlayPro => ["eaaccess"],
        UbisoftClassics or UbisoftPremium => ["ubisoftplus"],
        _ => [],
    };

    public static bool HasCatalog(string plan) => CatalogKeysFor(plan).Count > 0;

    /// <summary>Xbox Cloud Gaming comes with Essential, Premium and Ultimate (not PC Game Pass), per xbox.com/cloud-gaming.</summary>
    public static bool IncludesXboxCloud(string plan) => plan is GamePassEssential or GamePassPremium or GamePassUltimate;

    public static bool IsGamePass(string plan) => Family(plan) == FamilyGamePass;

    /// <summary>
    /// The stored comma list → valid plans, in picker order, at most one per family (the higher tier wins when the
    /// stored value somehow holds two). Unknown keys are dropped.
    /// </summary>
    public static IReadOnlyList<string> Parse(string? csv)
    {
        if (string.IsNullOrWhiteSpace(csv) || csv.Length > 400) return [];
        var picked = new HashSet<string>(csv.Split(',', StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries).Where(IsKnown), StringComparer.Ordinal);
        var result = new List<string>();
        // Walk from the highest tier down so each family keeps its best plan.
        foreach (var plan in All.Reverse())
        {
            if (!picked.Contains(plan) || result.Any(r => Family(r) == Family(plan))) continue;
            result.Add(plan);
        }
        return All.Where(result.Contains).ToList();
    }

    public static string Serialize(IEnumerable<string> plans) => string.Join(',', Parse(string.Join(',', plans)));

    /// <summary>The Game Pass tier the user has, if any.</summary>
    public static string? GamePassTier(IReadOnlyList<string> plans) => plans.FirstOrDefault(IsGamePass);
}
