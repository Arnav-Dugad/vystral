using System.Text.Json;
using System.Text.Json.Nodes;
using System.Text.RegularExpressions;
using Vystral.Core.Contracts;
using Vystral.Windows.Ai;
using Vystral.Windows.Ai.Assistant;
using Vystral.Windows.Bridge;
using Vystral.Windows.Recap;
using static Vystral.Windows.Bridge.BridgeDispatcher;

namespace Vystral.Windows;

// Track D3 parameter records.
public sealed record AsstWireMessage(string Role, string Content);
public sealed record AsstWireContext(string? Page, string? GameId, string? SessionId);
public sealed record AsstChatParams(string RequestId, IReadOnlyList<AsstWireMessage> Messages, AsstWireContext? Context, bool? ShareApproved);
public sealed record AsstRequestParams(string RequestId);
public sealed record AsstApproveParams(string RequestId, string ApprovalId, bool Allow, bool? Always);
public sealed record AsstConversationParams(string Id);
public sealed record AsstSaveParams(string Id, JsonElement Conversation);

/// <summary>
/// Track D3: the one Assistant. Chat with the chosen AI (cloud via the router, or local Ollama), streamed over
/// <c>assistant.event</c>, with validated tool calls over VYSTRAL's own data. Actions are only ever proposed; the page runs
/// them after the user confirms. Conversations are kept as small JSON files under the data folder when the user allows it.
/// </summary>
public sealed partial class AppBackend
{
    private AssistantService _assistant = null!;
    private AssistantHistory _assistantHistory = null!;

    private void RegisterAssistantHandlers()
    {
        _assistantHistory = new AssistantHistory(Path.Combine(Paths.Root, "assistant"));
        _assistant = new AssistantService(Settings, _cloudAi, _aiRouter, new AssistantHost(this), (name, payload) => _events.Emit(name, payload))
        {
            IsGameRunning = () => IsGameActive,
            SafeMode = SafeMode,
        };

        Dispatcher.Register("assistant.status", _ => Task.FromResult<object?>(_assistant.Status()));
        Dispatcher.Register<AsstChatParams>("assistant.chat", (p, _) =>
        {
            var requestId = RequireRequestId(p.RequestId);
            if (p.Messages is null || p.Messages.Count is 0 or > 60) throw new BridgeException("invalid", "Invalid conversation.");
            var messages = p.Messages.Select(m => new AsstInMessage(
                m.Role is "user" or "assistant" ? m.Role : throw new BridgeException("invalid", "Invalid conversation."),
                RequireText(m.Content, 8000, "Message", allowEmpty: m.Role == "assistant"))).ToList();
            if (messages[^1].Role != "user" || string.IsNullOrWhiteSpace(messages[^1].Content)) throw new BridgeException("invalid", "Ask something first.");
            var c = p.Context;
            var page = c?.Page is { } pg && AssistantService.Pages.Contains(pg) ? pg : "home";
            var gameId = c?.GameId is null ? null : RequireId(c.GameId, "game");
            var sessionId = c?.SessionId is null ? null : RequireId(c.SessionId, "session");
            _assistant.Start(new AsstChatInput(requestId, messages, new AsstContext(page, gameId, sessionId), p.ShareApproved ?? false));
            return Task.FromResult<object?>(true);
        });
        Dispatcher.Register<AsstRequestParams>("assistant.cancel", (p, _) => Task.FromResult<object?>(_assistant.Cancel(RequireRequestId(p.RequestId))));
        Dispatcher.Register<AsstApproveParams>("assistant.approve", (p, _) =>
        {
            var approvalId = p.ApprovalId is { Length: <= 20 } a && ApprovalId().IsMatch(a) ? a : throw new BridgeException("invalid", "Unknown request.");
            return Task.FromResult<object?>(_assistant.Approve(RequireRequestId(p.RequestId), approvalId, p.Allow, p.Always ?? false));
        });

        Dispatcher.Register("assistant.conversations", _ =>
            Task.FromResult<object?>(Settings.GetBool("assistant.keepHistory") ? _assistantHistory.List() : []));
        Dispatcher.Register<AsstConversationParams>("assistant.conversation.get", (p, _) =>
            Task.FromResult<object?>(_assistantHistory.Get(RequireConversationId(p.Id)) ?? throw new BridgeException("notFound", "That conversation is no longer saved.")));
        Dispatcher.Register<AsstSaveParams>("assistant.conversation.save", (p, _) =>
        {
            var id = RequireConversationId(p.Id);
            if (!Settings.GetBool("assistant.keepHistory")) return Task.FromResult<object?>(false);
            if (_assistantHistory.Save(id, p.Conversation) is { } error) throw new BridgeException("invalid", error);
            return Task.FromResult<object?>(true);
        });
        Dispatcher.Register<AsstConversationParams>("assistant.conversation.delete", (p, _) =>
        {
            _assistantHistory.Delete(RequireConversationId(p.Id));
            return Task.FromResult<object?>(true);
        });
        Dispatcher.Register("assistant.conversation.clear", _ =>
        {
            _assistantHistory.Clear();
            Repository.Audit("assistant.history.clear", null);
            return Task.FromResult<object?>(true);
        });
    }

    private static string RequireRequestId(string? id) =>
        id is not null && AssistantService.RequestIdPattern().IsMatch(id) ? id : throw new BridgeException("invalid", "Invalid request id.");

    private static string RequireConversationId(string? id) =>
        AssistantHistory.IsId(id) ? id! : throw new BridgeException("invalid", "Invalid conversation.");

    [GeneratedRegex(@"\Aap-[0-9]{1,12}\z")]
    private static partial Regex ApprovalId();

    /// <summary>What the assistant's tools read, over the app's own services and read-only bridge methods.</summary>
    private sealed class AssistantHost(AppBackend app) : IAssistantHost
    {
        public LibrarySnapshotDto Snapshot() => app.Library.Snapshot();

        public IReadOnlyList<SessionDto> Sessions(string? gameId, int limit) => app.Repository.ListSessions(gameId, limit);

        public DateTimeOffset Now => DateTimeOffset.Now;

        public TimeZoneInfo Zone => TimeZoneInfo.Local;

        public async Task<JsonNode?> ReadAsync(string method, object? args, CancellationToken ct)
        {
            if (!AssistantToolRunner.ReadMethods.Contains(method)) throw new BridgeException("invalid", "Not a read method.");
            var result = await app.Dispatcher.InvokeAsync(method, args, ct);
            return result is null ? null : JsonSerializer.SerializeToNode(result, BridgeDispatcher.Json);
        }

        public async Task<JsonNode?> DiscoverSearchAsync(string query, CancellationToken ct)
        {
            var search = app.Discover.Search(query, "assistant", 0);
            var waited = TimeSpan.Zero;
            while (!search.Done && waited < TimeSpan.FromSeconds(8))
            {
                await Task.Delay(400, ct);
                waited += TimeSpan.FromMilliseconds(400);
                search = app.Discover.Current("assistant") ?? search;
            }
            return JsonSerializer.SerializeToNode(search, BridgeDispatcher.Json);
        }

        public IReadOnlyList<TonightCandidate> Tonight(string mood, int minutes, bool includeSubs) =>
            TonightPlanner.Candidates(Snapshot().Games, TimeToBeat(), app._subs?.Map() ?? new Dictionary<string, IReadOnlyList<Subscriptions.SubsBadgeDto>>(),
                includeSubs ? app._subs?.Included() ?? [] : [], mood, minutes, includeSubs, DateTimeOffset.Now);

        public IReadOnlyDictionary<string, TimeToBeatDto> TimeToBeat() => app.TimeToBeatMap().Games;

        public JsonObject Settings() => app.Settings.GetAll();

        public bool FeatureEnabled(string feature) => app._aiRouter.FeatureEnabled(feature);
    }
}
