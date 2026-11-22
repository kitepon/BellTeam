using Android.Content;
using Android.Util;
using BellTeam.Linux;
using Java.Security;
using Javax.Crypto;
using Javax.Crypto.Spec;
using Kitepon.LoginBilling;

namespace BellTeam.Android;

// a492: the home record (base, token, session id) sealed with an AES-GCM key in the Android Keystore, like KeystoreSessionTokenStore; the ciphertext sits in this app's private preferences.
internal sealed class KeystoreHomeStore : IHomeStore
{
    private const string Alias = "bellteam.home", Provider = "AndroidKeyStore", Transform = "AES/GCM/NoPadding", Name = "record";
    private static ISharedPreferences Prefs => global::Android.App.Application.Context.GetSharedPreferences("bellteam.home", FileCreationMode.Private)!;

    private static IKey Key()
    {
        var store = KeyStore.GetInstance(Provider)!; store.Load(null);
        if (!store.ContainsAlias(Alias))
        {
            var generator = KeyGenerator.GetInstance(global::Android.Security.Keystore.KeyProperties.KeyAlgorithmAes, Provider)!;
            generator.Init(new global::Android.Security.Keystore.KeyGenParameterSpec.Builder(Alias, global::Android.Security.Keystore.KeyStorePurpose.Encrypt | global::Android.Security.Keystore.KeyStorePurpose.Decrypt)
                .SetBlockModes(global::Android.Security.Keystore.KeyProperties.BlockModeGcm).SetEncryptionPaddings(global::Android.Security.Keystore.KeyProperties.EncryptionPaddingNone).Build());
            generator.GenerateKey();
        }
        return store.GetKey(Alias, null)!;
    }

    public void Write(string record)
    {
        var cipher = Cipher.GetInstance(Transform)!; cipher.Init(CipherMode.EncryptMode, Key());
        var sealedBytes = cipher.DoFinal(System.Text.Encoding.UTF8.GetBytes(record))!;
        Prefs.Edit()!.PutString(Name, Base64.EncodeToString(cipher.GetIV(), Base64Flags.NoWrap) + ":" + Base64.EncodeToString(sealedBytes, Base64Flags.NoWrap))!.Apply();
    }

    public string? Read()
    {
        if (Prefs.GetString(Name, null)?.Split(':') is not [var iv, var body]) return null;
        try
        {
            var cipher = Cipher.GetInstance(Transform)!; cipher.Init(CipherMode.DecryptMode, Key(), new GCMParameterSpec(128, Base64.Decode(iv, Base64Flags.NoWrap)));
            return System.Text.Encoding.UTF8.GetString(cipher.DoFinal(Base64.Decode(body, Base64Flags.NoWrap))!);
        }
        // The key was lost (a restored backup, a changed lock screen): the record cannot be read, so the app logs in again.
        catch (Exception) { Delete(); return null; }
    }

    public void Delete() => Prefs.Edit()!.Remove(Name)!.Apply();
}

// The android part's HomeConnection behind IHomeLink.
internal sealed class AndroidHomeLink(LoginBilling lb, IHomeStore store) : IHomeLink
{
    private readonly HomeConnection home = lb.HomeConnection(store);

    private static async Task<T> Map<T>(Func<Task<T>> call)
    {
        try { return await call(); }
        catch (LoginBillingException error) { throw new HomeLinkException(error.Code, error.Status); }
    }

    public Task ConnectAsync(string baseUrl, string kind, string? setupCode, CancellationToken token) => Map(async () => await home.ConnectHomeAsync(baseUrl, kind, setupCode, null, token));
    public string? Token(string url) => home.HomeHeader(url) is { } header && header.StartsWith("Bearer ", StringComparison.Ordinal) ? header["Bearer ".Length..] : null;
    public Task EndAsync(CancellationToken token) => Map(async () => { await home.EndHomeSessionAsync(token); return 0; });
    public Task ReproveIfDueAsync(string? ticketFor, CancellationToken token) => Map(async () => await home.ReproveIfDueAsync(ticketFor, token));
    public void Forget(string url) { if (home.HomeHeader(url) is not null) store.Delete(); }
}
