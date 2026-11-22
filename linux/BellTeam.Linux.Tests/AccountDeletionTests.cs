using BellTeam.Core;
using Xunit;

namespace BellTeam.Linux;

public sealed class AccountDeletionTests
{
    // Rapi's Mac reference (docs/architecture/modules/apple/account-deletion.md) is the contract: only the subscription sentences may differ per platform.
    private const string AppleMessage = "この端末のBellTeamのサインインを、届く限りすべて終わらせます。この端末にある店のパス・アカウントの番号・サーバーのトークン・決裁箱のサインインと鍵・保存した会話の写しを消して、最初の画面に戻ります。ログインの運営は、このアカウントに結びつけた情報を持っていません。ほかの端末のサインインは、その端末で終えてください。購読はAppleのものなので、この操作では解約されません。解約は「設定」のApple Accountの購読から行ってください。サーバーの会話や設定は消えません。";
    private const string AppleDone = "この端末のサインインとデータを消しました。ログインの運営には、このアカウントの情報は残っていません。購読を止めるには、Apple Accountの購読の管理から解約してください。";

    [Fact]
    public void TheWordsAreTheMacReferenceWithOnlyTheStoreSentencesChanged()
    {
        Assert.Equal(AppleMessage, AccountDeletionText.ConfirmBody("購読はAppleのものなので、この操作では解約されません。解約は「設定」のApple Accountの購読から行ってください。"));
        Assert.Equal(AppleDone, AccountDeletionText.ResultBody("購読を止めるには、Apple Accountの購読の管理から解約してください。"));
        Assert.Equal(("アカウントを削除", "アカウントを削除しますか？", "削除する", "やめる", "アカウントを削除しました"),
            (AccountDeletionText.Button, AccountDeletionText.ConfirmTitle, AccountDeletionText.ConfirmYes, AccountDeletionText.ConfirmNo, AccountDeletionText.ResultTitle));
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
