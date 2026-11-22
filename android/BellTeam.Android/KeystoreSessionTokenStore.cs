using Android.Content;
using Android.Security.Keystore;
using Android.Util;
using BellTeam.Core;
using Java.Security;
using Javax.Crypto;
using Javax.Crypto.Spec;

namespace BellTeam.Android;

// a485: the server's session token per server address, encrypted with an AES-GCM key that lives in the Android Keystore (the key never leaves it); the ciphertext sits in this app's private preferences.
public sealed class KeystoreSessionTokenStore : ISessionTokenStore
{
    private const string Alias = "bellteam.session", Provider = "AndroidKeyStore", Transform = "AES/GCM/NoPadding";
    private static ISharedPreferences Prefs => global::Android.App.Application.Context.GetSharedPreferences("bellteam.sessions", FileCreationMode.Private)!;

    private static IKey Key()
    {
        var store = KeyStore.GetInstance(Provider)!; store.Load(null);
        if (!store.ContainsAlias(Alias))
        {
            var generator = KeyGenerator.GetInstance(KeyProperties.KeyAlgorithmAes, Provider)!;
            generator.Init(new KeyGenParameterSpec.Builder(Alias, KeyStorePurpose.Encrypt | KeyStorePurpose.Decrypt).SetBlockModes(KeyProperties.BlockModeGcm).SetEncryptionPaddings(KeyProperties.EncryptionPaddingNone).Build());
            generator.GenerateKey();
        }
        return store.GetKey(Alias, null)!;
    }

    public void Save(Uri origin, string token)
    {
        var cipher = Cipher.GetInstance(Transform)!; cipher.Init(CipherMode.EncryptMode, Key());
        var sealedBytes = cipher.DoFinal(System.Text.Encoding.UTF8.GetBytes(token))!;
        Prefs.Edit()!.PutString(origin.AbsoluteUri, Base64.EncodeToString(cipher.GetIV(), Base64Flags.NoWrap) + ":" + Base64.EncodeToString(sealedBytes, Base64Flags.NoWrap))!.Apply();
    }

    public string? Load(Uri origin)
    {
        if (Prefs.GetString(origin.AbsoluteUri, null)?.Split(':') is not [var iv, var body]) return null;
        try
        {
            var cipher = Cipher.GetInstance(Transform)!; cipher.Init(CipherMode.DecryptMode, Key(), new GCMParameterSpec(128, Base64.Decode(iv, Base64Flags.NoWrap)));
            return System.Text.Encoding.UTF8.GetString(cipher.DoFinal(Base64.Decode(body, Base64Flags.NoWrap))!);
        }
        // The key was lost (a restored backup, a changed lock screen): the token cannot be read, so the app logs in again.
        catch (Exception) { Clear(origin); return null; }
    }

    public void Clear(Uri origin) => Prefs.Edit()!.Remove(origin.AbsoluteUri)!.Apply();
}
