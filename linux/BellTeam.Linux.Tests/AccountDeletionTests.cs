using BellTeam.Core;
using Xunit;

namespace BellTeam.Linux;

public sealed class AccountDeletionTests
{
    // Rapi's Mac reference (docs/architecture/modules/apple/account-deletion.md) is the contract: only the subscription sentences may differ per platform.
    private const string AppleMessage = "この端末のBellTeamのサインインを、届く限りすべて終わらせます。この端末にある店のパス・アカウントの番号・サーバーのトークン・決裁箱のサインインと鍵・保存した会話の写しを消して、最初の画面に戻ります。ログインの運営は、名前・メールアドレス・購入の記録を持っていません。ログインの運営に残るのは、止めたパスのランダムな番号と、「ほかの端末をすべて止める」を使った時のアカウントの番号とその時刻だけで、どちらも最長14日で消えます。ほかの端末のサインインは、その端末で終えてください。購読はAppleのものなので、この操作では解約されません。解約は「設定」のApple Accountの購読から行ってください。サーバーの会話や設定は消えません。";
    private const string AppleDone = "この端末のサインインとデータを消しました。ログインの運営に残るのは、止めたパスのランダムな番号と、「ほかの端末をすべて止める」を使った時のアカウントの番号とその時刻だけで、どちらも最長14日で消えます。購読を止めるには、Apple Accountの購読の管理から解約してください。";

    [Fact]
    public void TheWordsAreTheMacReferenceWithOnlyTheStoreSentencesChanged()
    {
        Assert.Equal(AppleMessage, AccountDeletionText.ConfirmBody("購読はAppleのものなので、この操作では解約されません。解約は「設定」のApple Accountの購読から行ってください。"));
        Assert.Equal(AppleDone, AccountDeletionText.ResultBody("購読を止めるには、Apple Accountの購読の管理から解約してください。"));
        Assert.Equal(("アカウントを削除", "アカウントを削除しますか？", "削除する", "やめる", "アカウントを削除しました"),
            (AccountDeletionText.Button, AccountDeletionText.ConfirmTitle, AccountDeletionText.ConfirmYes, AccountDeletionText.ConfirmNo, AccountDeletionText.ResultTitle));
    }

    [Fact]
    public void AFailedStepIsListedInRapisWordsWithOneOfTheThreeReasons()
    {
        var failed = new DeletionFailures(); Assert.False(failed.Any);
        failed.Add("通知の登録", new HttpRequestException("offline"));
        failed.Add("BellTeamのサインイン", new InvalidOperationException("x"), 503);
        failed.Add("サーバーのサインイン", new InvalidOperationException("y"), 400);
        Assert.True(failed.Any);
        Assert.Equal(string.Join('\n', AccountDeletionText.Failed("通知の登録", AccountDeletionText.NoNetwork), AccountDeletionText.Failed("BellTeamのサインイン", AccountDeletionText.OperatorUnreachable), AccountDeletionText.Failed("サーバーのサインイン", AccountDeletionText.NotProcessed)), failed.Text);
        Assert.Equal(AccountDeletionText.NoNetwork, DeletionFailures.ReasonOf(new InvalidOperationException("z", new TimeoutException()), 0));
    }

    [Fact]
    public void TheSessionTokenFileGoesForEveryServer()
    {
        var directory = Directory.CreateTempSubdirectory("bellteam-delete-").FullName; var store = new FileSessionTokenStore(directory);
        store.Save(new Uri("http://a/"), "ta"); store.Save(new Uri("http://b/"), "tb");
        FileSessionTokenStore.DeleteAll(directory);
        Assert.Null(store.Load(new Uri("http://a/"))); Assert.Null(store.Load(new Uri("http://b/")));
        FileSessionTokenStore.DeleteAll(directory);   // already gone: not an error
    }
}
