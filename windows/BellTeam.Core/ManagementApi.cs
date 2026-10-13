namespace BellTeam.Core;

public sealed class ManagementApi(BellApi api)
{
    public BellApi Api { get; } = api;
    public Task<BotSettingsResponse> GetBotAsync(string id, CancellationToken token = default) => Api.GetAsync<BotSettingsResponse>(new ChatTarget(id, false).Path, token);
    public Task<BotSettingsResponse> SaveBotAsync(string id, Dictionary<string, object?> changes, CancellationToken token = default) => Api.WriteAsync<BotSettingsResponse>(HttpMethod.Patch, new ChatTarget(id, false).Path, changes, token);
    public async Task<bool> ConfirmBotAsync(string id, Dictionary<string, object?> changes, CancellationToken token = default) => (await GetBotAsync(id, token)).Bot.Matches(changes);
    public async Task<Room> CreateRoomAsync(RoomSettings settings, CancellationToken token = default) => (await Api.PostAsync<RoomResponse>("/api/rooms", settings, token)).Room;
    public async Task<Room> UpdateRoomAsync(string id, Dictionary<string, object?> changes, CancellationToken token = default) => (await Api.WriteAsync<RoomResponse>(HttpMethod.Patch, new ChatTarget(id, true).Path, changes, token)).Room;
    public Task DeleteRoomAsync(string id, CancellationToken token = default) => Api.DeleteAsync(new ChatTarget(id, true).Path, token);
}
