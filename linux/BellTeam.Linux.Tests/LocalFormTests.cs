using BellTeam.Core;
using Xunit;

namespace BellTeam.Linux;

// a540 (contract 1.36 s10): the library's error codes reach the person in Rapi's table (Tronie: one spec on every platform); a code the table does not name says itself.
public sealed class LocalFormTests
{
    [Theory]
    [InlineData("unreachable_same_wifi", LocalFormOutcome.SameWifi)]
    [InlineData("local_network_denied", LocalFormOutcome.LocalNetworkDenied)]
    [InlineData("other_account", LocalFormOutcome.AnotherAccount)]
    [InlineData("request_expired", LocalFormOutcome.Ended)]
    [InlineData("request_gone", LocalFormOutcome.Ended)]
    [InlineData("ended", LocalFormOutcome.Lapsed)]
    [InlineData("qr_invalid", LocalFormOutcome.Refused)]
    public void ATriesOwnCodeIsTheTablesSentence(string code, LocalFormOutcome outcome) => Assert.Equal(LocalFormText.Of(outcome), LocalFormText.Failure(code));

    [Fact]
    public void ACodeWithItsOwnLineKeepsItAndAnUnknownOneShowsItsCode()
    {
        Assert.Equal("購入を確かめられませんでした（not_paid）。", LocalFormText.Failure("not_paid"));
        Assert.Equal("相手が返事を受け取りませんでした。相手の画面で新しいQRを出してください。", LocalFormText.Failure("device_refused"));
        Assert.All(new[] { "purchase_failed", "purchase_unverified" }, code => Assert.Equal("購入を完了できませんでした。もう一度お試しください。", LocalFormText.Failure(code)));
        Assert.Equal("処理できませんでした（brand_new_code）。", LocalFormText.Failure("brand_new_code", 7));
    }

    [Theory]
    [InlineData("request_invalid")]
    [InlineData("other_request")]
    public void AnOlderPeerEndsInATextThatTellsThePersonToUpdate(string code) => Assert.Contains("最新版に更新", LocalFormText.Failure(code));

    [Fact]
    public void AppleSignInFailureShowsOnlyAppleOwnCodeAndASignedOutPhoneIsAskedToSignIn()
    {
        Assert.Equal("サインインできませんでした（invalid_client）。", LocalFormText.Failure("signin_failed", null, "invalid_client"));
        Assert.Equal("サインインできませんでした。もう一度お試しください。", LocalFormText.Failure("signin_failed"));
        Assert.Equal("サインインしてから、もう一度お試しください。", LocalFormText.Failure("signin_required"));
    }

    [Fact]
    public void TheLibraryIsBuiltWithAppleWebAndTheServicesIdAmongTheAudiences()
    {
        // the library's constructor throws when the Services ID is not an audience or the return address is not https
        Assert.NotNull(LinuxAccountStore.Local);
        Assert.StartsWith("https://", LocalFormIds.AppleReturnUrl);
    }

    [Fact]
    public void EveryOutcomeButPaidHasItsOwnSentence()
    {
        var sentences = Enum.GetValues<LocalFormOutcome>().Where(o => o != LocalFormOutcome.Paid).Select(LocalFormText.Of).ToArray();
        Assert.Equal(sentences.Length, sentences.Distinct().Count());
    }
}
