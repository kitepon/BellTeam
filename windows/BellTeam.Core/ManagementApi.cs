namespace BellTeam.Core;

public sealed class ManagementApi(BellApi api)
{
    public BellApi Api { get; } = api;
    public Task<BotSettingsResponse> GetBotAsync(string id, CancellationToken token = default) => Api.GetAsync<BotSettingsResponse>(new ChatTarget(id, false).Path, token);
    public Task<BotSettingsResponse> SaveBotAsync(string id, Dictionary<string, object?> changes, CancellationToken token = default) => Api.WriteAsync<BotSettingsResponse>(HttpMethod.Patch, new ChatTarget(id, false).Path, changes, token);
    public async Task<AvatarProfile> GetAvatarProfileAsync(string id, CancellationToken token = default) => (await Api.GetAsync<AvatarProfileResponse>(new ChatTarget(id, false).Path, token)).Bot;
    public async Task<AvatarSaveResult> SaveAvatarAsync(string id, AvatarVariant variant, AvatarSelection selection, CancellationToken token = default)
    {
        try { await Api.WriteAsync<System.Text.Json.JsonElement>(HttpMethod.Patch, new ChatTarget(id, false).Path, AvatarWire.Body(variant, selection), token); return new(AvatarSaveOutcome.Saved); }
        catch (Exception error) when (AvatarWire.IsConnectionLoss(error, token)) { return await ConfirmAvatarAsync(id, variant, selection, token); }
    }
    // A read only: compares what the server holds with the selection. A failed read is "unconfirmed", never a reason to send again.
    public async Task<AvatarSaveResult> ConfirmAvatarAsync(string id, AvatarVariant variant, AvatarSelection selection, CancellationToken token = default)
    {
        try { return new((await GetAvatarProfileAsync(id, token)).Matches(variant, selection) ? AvatarSaveOutcome.Confirmed : AvatarSaveOutcome.Different); }
        catch (BellApiException error) when (error.RequiresLogin) { throw; }
        catch (OperationCanceledException) when (token.IsCancellationRequested) { throw; }
        catch (Exception error) { return new(AvatarSaveOutcome.Unconfirmed, error); }
    }
    public Task<BotSettingsResponse> CreateBotAsync(BotSettings settings, CancellationToken token = default) => Api.PostAsync<BotSettingsResponse>("/api/bots", settings.Normalized.Fields(), token);
    public Task<System.Text.Json.JsonElement> RestartBotAsync(string id, CancellationToken token = default) => Api.PostAsync<System.Text.Json.JsonElement>(new ChatTarget(id, false).Path + "/restart", new { }, token);
    public async Task<bool> ConfirmBotAsync(string id, Dictionary<string, object?> changes, CancellationToken token = default) => (await GetBotAsync(id, token)).Bot.Matches(changes);
    public async Task<Room> CreateRoomAsync(RoomSettings settings, CancellationToken token = default) => (await Api.PostAsync<RoomResponse>("/api/rooms", settings with { Purpose = TextContent.Normalize(settings.Purpose) }, token)).Room;
    public async Task<Room> UpdateRoomAsync(string id, Dictionary<string, object?> changes, CancellationToken token = default) => (await Api.WriteAsync<RoomResponse>(HttpMethod.Patch, new ChatTarget(id, true).Path, changes, token)).Room;
    public Task DeleteRoomAsync(string id, CancellationToken token = default) => Api.DeleteAsync(new ChatTarget(id, true).Path, token);
}
