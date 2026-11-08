using System.Net.Http;

namespace BellTeam.Core;

public enum AvatarVariant { Small, Large }

public static class AvatarVariants
{
    // The crop canvas edge in pixels: Mac AvatarCropVariant.canvas.
    public static int Side(this AvatarVariant variant) => variant == AvatarVariant.Small ? 512 : 1024;
    public static string Label(this AvatarVariant variant) => variant == AvatarVariant.Small ? "小画像" : "大画像";
}

public sealed record AvatarCropRect(double X, double Y, double Width, double Height);
public sealed record AvatarSelection(string Render, string Source, AvatarCropRect Crop);

// GET /api/bots/{id}: the image fields only. A null field means the server does not send it (an older server).
public sealed record AvatarProfile
{
    public string? Avatar { get; init; }
    public string? AvatarLarge { get; init; }
    public string? AvatarSource { get; init; }
    public string? AvatarLargeSource { get; init; }
    public AvatarCropRect? AvatarCrop { get; init; }
    public AvatarCropRect? AvatarLargeCrop { get; init; }
    public bool SupportsIndependentImages => AvatarLarge is not null && AvatarSource is not null && AvatarLargeSource is not null;
    public (string Render, string Source, AvatarCropRect? Crop) AdjustmentImage(AvatarVariant variant)
        => variant == AvatarVariant.Large && !string.IsNullOrEmpty(AvatarLarge) ? (AvatarLarge, AvatarLargeSource ?? "", AvatarLargeCrop) : (Avatar ?? "", AvatarSource ?? "", AvatarCrop);
    public bool Matches(AvatarVariant variant, AvatarSelection selection) => variant == AvatarVariant.Small
        ? Avatar == selection.Render && AvatarSource == selection.Source && AvatarCrop == selection.Crop
        : AvatarLarge == selection.Render && AvatarLargeSource == selection.Source && AvatarLargeCrop == selection.Crop;
}
public sealed record AvatarProfileResponse { public required AvatarProfile Bot { get; init; } }

public enum AvatarSaveOutcome { Saved, Confirmed, Different, Unconfirmed }
public sealed record AvatarSaveResult(AvatarSaveOutcome Outcome, Exception? Error = null);

// Mac AvatarSelectionDrafts: a chosen image is kept until the server is known to hold it or the owner discards it.
public sealed class AvatarSelectionDrafts
{
    private readonly Dictionary<AvatarVariant, AvatarSelection> selections = [];
    public bool IsEmpty => selections.Count == 0;
    public AvatarSelection? Selection(AvatarVariant variant) => selections.GetValueOrDefault(variant);
    public void Select(AvatarSelection selection, AvatarVariant variant) => selections[variant] = selection;
    public void Discard(AvatarVariant variant) => selections.Remove(variant);
    // False when the selection was replaced or discarded while the request ran; the result is then ignored.
    public bool Finish(AvatarSaveResult? result, AvatarVariant variant, AvatarSelection selection)
    {
        if (selections.GetValueOrDefault(variant) != selection) return false;
        if (result?.Outcome is AvatarSaveOutcome.Saved or AvatarSaveOutcome.Confirmed) selections.Remove(variant);
        return true;
    }
}

public static class BotProfileText
{
    public const string DefaultValue = "CLIの既定";
    public static string OrDefault(string value) => value.Length == 0 ? DefaultValue : value;
    public const string UnsupportedServer = "画像の独立編集はサーバー更新後に利用できます。";
    public const string PendingKept = "保存結果を確認できていない画像の選択を保持しています。";
    public const string ChangeBlocked = "別の画像に変更するには、保持中の選択を破棄してください。";
    public const string NoSourceNote = "元画像が残っていない場合、現在の切り抜きの外側は復元できません。";
    public const string Different = "サーバーの画像は選んだ内容と一致しません。選択は保持しています。";
    public const string LoginNeeded = "認証が必要です。選択は保持しています。";
    public static string Unconfirmed(Exception? error) => "保存結果を確認できませんでした。選択は保持しています。\n" + error?.Message;
    public static string RefreshFailed(Exception error) => "画像を保存しましたが、表示を更新できませんでした。\n" + error.Message;
    public static string Failed(AvatarVariant variant, string error) => variant.Label() + "：" + error;
}

// Mac BotProfileImageState without the UI: the pending selection, the busy flag and every message the inspector shows.
public sealed class AvatarImageSession
{
    private readonly AvatarSelectionDrafts pending = new();
    private readonly Dictionary<AvatarVariant, string> errors = [];
    // Saved, but the roster refresh failed and the shown image has not caught up.
    private readonly HashSet<AvatarVariant> refreshFailed = [];
    public event Action? Changed;
    public bool Saving { get; private set; }
    public string? Message { get; private set; }
    public AvatarSelection? Pending(AvatarVariant variant) => pending.Selection(variant);
    public string? Error(AvatarVariant variant) => errors.GetValueOrDefault(variant);
    private void SetError(AvatarVariant variant, string? text) { if (text is null) errors.Remove(variant); else errors[variant] = text; }

    // False while a save runs: the sheet does not open then.
    public bool OpenActions() { if (Saving) return false; Message = null; Changed?.Invoke(); return true; }
    public void Discard(AvatarVariant variant)
    {
        if (Saving) return;
        pending.Discard(variant); refreshFailed.Remove(variant); SetError(variant, null); Message = "選択を破棄しました。"; Changed?.Invoke();
    }
    // The roster moved to a newer image: an old refresh failure is stale now.
    public void VersionChanged(AvatarVariant variant)
    {
        if (!refreshFailed.Remove(variant)) return;
        SetError(variant, null); Message = "画像を保存しました。"; Changed?.Invoke();
    }
    // Test and render seam: a selection kept from an earlier unconfirmed save.
    public void Keep(AvatarVariant variant, AvatarSelection selection, string? error = null) { pending.Select(selection, variant); SetError(variant, error); Changed?.Invoke(); }
    private bool NoteRefreshFailure(Exception error, AvatarVariant variant, string? versionBefore, string? versionNow, string success)
    {
        if (versionNow != versionBefore) { Message = success; return true; }
        refreshFailed.Add(variant); SetError(variant, BotProfileText.RefreshFailed(error)); return false;
    }

    public async Task SaveAsync(ManagementApi api, string botId, AvatarVariant variant, AvatarSelection selection, Func<AvatarVariant, string?> version, Func<Task> refresh, CancellationToken token)
    {
        if (Saving) return;
        pending.Select(selection, variant); refreshFailed.Remove(variant); SetError(variant, null);
        var before = version(variant);
        Saving = true; Changed?.Invoke();
        try
        {
            var result = await api.SaveAvatarAsync(botId, variant, selection, token);
            if (!pending.Finish(result, variant, selection)) return;
            await ApplyAsync(result, variant, before, version, refresh, "画像を保存しました。");
        }
        catch (BellApiException error) when (error.RequiresLogin) { if (pending.Selection(variant) == selection) SetError(variant, BotProfileText.LoginNeeded); }
        catch (OperationCanceledException) when (token.IsCancellationRequested) { }
        catch (Exception error) { if (pending.Finish(null, variant, selection)) SetError(variant, error.Message); }
        finally { Saving = false; Changed?.Invoke(); }
    }

    // True when the sheet should close (the save is confirmed).
    public async Task<bool> ConfirmAsync(ManagementApi api, string botId, AvatarVariant variant, Func<AvatarVariant, string?> version, Func<Task> refresh, CancellationToken token)
    {
        if (Saving || pending.Selection(variant) is not { } selection) return false;
        refreshFailed.Remove(variant);
        var before = version(variant);
        Saving = true; Changed?.Invoke();
        try
        {
            var result = await api.ConfirmAvatarAsync(botId, variant, selection, token);
            if (!pending.Finish(result, variant, selection)) return false;
            return await ApplyAsync(result, variant, before, version, refresh, "画像の保存を確認しました。");
        }
        catch (BellApiException error) when (error.RequiresLogin) { if (pending.Selection(variant) == selection) SetError(variant, BotProfileText.LoginNeeded); }
        catch (OperationCanceledException) when (token.IsCancellationRequested) { }
        catch (Exception error) { if (pending.Selection(variant) == selection) SetError(variant, BotProfileText.Unconfirmed(error)); }
        finally { Saving = false; Changed?.Invoke(); }
        return false;
    }

    private async Task<bool> ApplyAsync(AvatarSaveResult result, AvatarVariant variant, string? before, Func<AvatarVariant, string?> version, Func<Task> refresh, string success)
    {
        switch (result.Outcome)
        {
            case AvatarSaveOutcome.Saved or AvatarSaveOutcome.Confirmed:
                SetError(variant, null);
                try { await refresh(); Message = success; return true; }
                catch (BellApiException error) when (error.RequiresLogin) { throw; }
                catch (Exception error) when (error is not OperationCanceledException) { return NoteRefreshFailure(error, variant, before, version(variant), success); }
            case AvatarSaveOutcome.Different: SetError(variant, BotProfileText.Different); return false;
            default: SetError(variant, BotProfileText.Unconfirmed(result.Error)); return false;
        }
    }
}

public static class AvatarWire
{
    // The PATCH body of an image-only save: the three fields of one variant, as the server's previewUpdate requires them together.
    public static Dictionary<string, object?> Body(AvatarVariant variant, AvatarSelection selection) => variant == AvatarVariant.Small
        ? new() { ["avatar"] = selection.Render, ["avatarSource"] = selection.Source, ["avatarCrop"] = selection.Crop }
        : new() { ["avatarLarge"] = selection.Render, ["avatarLargeSource"] = selection.Source, ["avatarLargeCrop"] = selection.Crop };
    // A lost connection or a timeout: the server may have saved, so the result is read back (never re-sent).
    public static bool IsConnectionLoss(Exception error, CancellationToken token) => error is HttpRequestException || error is OperationCanceledException && !token.IsCancellationRequested;
}
