using BellTeam.Core;
using Xunit;

namespace BellTeam.Linux;

// a540 (contract 1.36 s10): the library's error codes reach the person in the local form's words; a code that is not a try's own outcome keeps the account words.
public sealed class LocalFormTests
{
    [Theory]
    [InlineData("unreachable_same_wifi", LocalFormOutcome.SameWifi)]
    [InlineData("local_network_denied", LocalFormOutcome.LocalNetworkDenied)]
    [InlineData("not_paid", LocalFormOutcome.NoPurchase)]
    [InlineData("other_account", LocalFormOutcome.AnotherAccount)]
    [InlineData("request_expired", LocalFormOutcome.Ended)]
    [InlineData("ended", LocalFormOutcome.Lapsed)]
    [InlineData("revoked", LocalFormOutcome.Lapsed)]
    [InlineData("request_gone", LocalFormOutcome.Refused)]
    [InlineData("proof_invalid", LocalFormOutcome.Refused)]
    [InlineData("device_refused", LocalFormOutcome.Refused)]
    public void ATriesOwnCodeIsTheOutcomeSentence(string code, LocalFormOutcome outcome) => Assert.Equal(LocalFormText.Of(outcome), LocalFormText.Failure(code));

    [Fact]
    public void ASignInCodeKeepsTheAccountWordsAndAnUnknownOneShowsItsCode()
    {
        Assert.Equal(StoreAccountText.Failure("signin_cancelled"), LocalFormText.Failure("signin_cancelled"));
        Assert.Contains("brand_new_code", LocalFormText.Failure("brand_new_code", 7));
    }

    [Fact]
    public void EveryOutcomeButPaidHasItsOwnSentence()
    {
        var sentences = Enum.GetValues<LocalFormOutcome>().Where(o => o != LocalFormOutcome.Paid).Select(LocalFormText.Of).ToArray();
        Assert.Equal(sentences.Length, sentences.Distinct().Count());
    }
}
