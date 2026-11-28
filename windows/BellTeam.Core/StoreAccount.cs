namespace BellTeam.Core;

// The store account of an app that signs in with Google or Apple itself (login-billing contract 1.20, a485). Plain strings so Core needs no library type:
// passKind is the library's "none" | "store" | "handoff"; entitlementCount is how many entitlements the pass holds.
public enum StoreAccountState { SignedOut, SignedInNeedsPurchase, SignedInEntitled, Handoff, Signed }

public static class StoreAccount
{
    public static StoreAccountState Of(string passKind, int entitlementCount) => passKind switch
    {
        "store" => entitlementCount > 0 ? StoreAccountState.SignedInEntitled : StoreAccountState.SignedInNeedsPurchase,
        "handoff" => StoreAccountState.Handoff,
        "signed" => StoreAccountState.Signed, // web sign-in (contract 1.20): never buys here
        _ => StoreAccountState.SignedOut,
    };

    // The Mac 利用と課金 page head (SettingsSummary.billing): one badge and one sentence.
    public static (string Badge, SettingsTone Tone, string Line) Status(bool entitled)
        => entitled ? (CoreStrings.PlanningModels_StatusText_2, SettingsTone.Green, CoreStrings.StoreAccount_Status_2) : (CoreStrings.PlanningModels_StatusText_4, SettingsTone.Gray, CoreStrings.StoreAccount_Status_4);
}

// Provisional words (the contract fixes behaviour, not copy): Tronie decides the final wording. No e-mail or name exists anywhere, so none is shown.
public static class StoreAccountText
{
    public static string Title  => CoreStrings.StoreAccount_Title_1;
    public static string SignedOut  => CoreStrings.StoreAccount_SignedOut_1;
    public static string SignIn  => CoreStrings.SignIn_Google_1;
    public static string SignedIn  => CoreStrings.StoreAccount_SignedIn_1;
    // Desktop (Linux, Windows): the library signs in through the system browser and returns to a loopback address; no purchase happens here (login-billing 0.14.0). Provisional words, like the rest.
    public static string SignInApple  => CoreStrings.SignIn_Apple_1;
    public static string SigningInWeb  => CoreStrings.StoreAccount_SigningInWeb_1;
    public static string SigningInWebCancel  => CoreStrings.AccountDeletionText_ConfirmNo_1;
    public static string StopAllOthersWhyWeb  => CoreStrings.StoreAccount_StopAllOthersWhyWeb_1;
    public static string StopAllOthersGoogle  => CoreStrings.StoreAccount_StopAllOthersGoogle_1;
    public static string StopAllOthersApple  => CoreStrings.StoreAccount_StopAllOthersApple_1;
    public static string SignedInBrowser  => CoreStrings.StoreAccount_SignedInBrowser_1;
    public static string WebCannotBuy  => CoreStrings.StoreAccount_WebCannotBuy_1;
    public static string HandoffCancel  => CoreStrings.AccountDeletionText_ConfirmNo_1;
    public static string HandoffCancelled  => CoreStrings.StoreAccount_HandoffCancelled_1;
    public static string StopAllOthersWhy  => CoreStrings.StoreAccount_StopAllOthersWhy_1;
    public static string StopAllOthersConfirm  => CoreStrings.StoreAccount_StopAllOthersConfirm_1;
    public static string StopAllOthersCancel  => CoreStrings.StoreAccount_StopAllOthersCancel_1;   // not やめる: 止める and やめる sound the same side by side (Mika, 7f)
    public static string HandoffAgain  => CoreStrings.StoreAccount_HandoffAgain_1;
    public static string Refresh  => CoreStrings.StoreAccount_Refresh_1;
    public static string StopAllOthers  => CoreStrings.StoreAccount_StopAllOthers_1;
    public static string SignOut  => CoreStrings.StoreAccount_SignOut_1;
    // app-sessions.md 7f (Mika), the handoff QR for a device with no store receipt: Anis's sentences as written.
    public static string HandoffTitle  => CoreStrings.StoreAccount_HandoffTitle_1;
    public static string HandoffLead  => CoreStrings.StoreAccount_HandoffLead_1;
    public static string HandoffCode  => CoreStrings.StoreAccount_HandoffCode_1;
    public static string HandoffCheckNumber  => CoreStrings.StoreAccount_HandoffCheckNumber_1;
    public static string HandoffCheckLine  => CoreStrings.StoreAccount_HandoffCheckLine_1;
    public static string HandoffWaiting  => CoreStrings.StoreAccount_HandoffWaiting_1;
    // The phone that holds the contract (a store pass) lets another device in, and lists and stops the devices it let in (contract 1.20; a desktop is only ever the device that gets approved). Provisional words.
    public static string ApproveTitle  => CoreStrings.StoreAccount_ApproveTitle_1;
    public static string ApproveLead  => CoreStrings.StoreAccount_ApproveLead_1;
    public static string ApproveScan  => CoreStrings.StoreAccount_ApproveScan_1;
    public static string ApproveScannerTitle  => CoreStrings.StoreAccount_ApproveScan_1;
    public static string ApproveClose  => CoreStrings.StoreAccount_ApproveClose_1;
    public static string ApproveCodeLabel  => CoreStrings.StoreAccount_HandoffCode_1;
    public static string ApproveCodeGo  => CoreStrings.SettingsModels_From_7;
    public static string ApproveCheckLine  => CoreStrings.StoreAccount_ApproveCheckLine_1;
    public static string ApproveOwnLine  => CoreStrings.StoreAccount_ApproveOwnLine_1;
    public static string ApproveYes  => CoreStrings.StoreAccount_ApproveYes_1;
    public static string ApproveNo  => CoreStrings.AccountDeletionText_ConfirmNo_1;
    public static string ApprovedLine  => CoreStrings.StoreAccount_ApprovedLine_1;
    public static string DeclinedLine  => CoreStrings.StoreAccount_DeclinedLine_1;
    public static string NotNeededLine  => CoreStrings.StoreAccount_NotNeededLine_1;
    public static string ApproveScanFailed  => CoreStrings.StoreAccount_ApproveScanFailed_1;
    public static string ApproveConfirmAsk  => CoreStrings.StoreAccount_ApproveConfirmAsk_1;
    public static string ApproveNoPurchase  => CoreStrings.StoreAccount_ApproveNoPurchase_1;
    public static string ApproveDevice(string label) => CoreStrings.StoreAccount_ApproveDevice_1(label);
    public static string LinkedTitle  => CoreStrings.StoreAccount_LinkedTitle_1;
    public static string LinkedNone  => CoreStrings.StoreAccount_LinkedNone_1;
    public static string LinkedStop  => CoreStrings.StoreAccount_StopAllOthersConfirm_1;
    public static string AlreadyEntitled  => CoreStrings.StoreAccount_AlreadyEntitled_1;
    public static string GateNext  => CoreStrings.StoreAccount_GateNext_1;   // provisional (Tronie/Mika): the step after the account on first run
    public static string NotConfigured  => CoreStrings.StoreAccount_NotConfigured_1;
    public static string Buy(string price) => CoreStrings.StoreAccount_Buy_1(price);
    // The period comes from the offer's ISO 8601 billing period (P1M, P1Y, P1W, P3M...), never hard-coded; an unknown period shows the price alone.
    public static string Buy(string price, string? billingPeriod) => Period(billingPeriod) is { } period ? CoreStrings.StoreAccount_Buy_2(period, price) : Buy(price);
    private static string? Period(string? iso) => iso switch { "P1W" => CoreStrings.StoreAccount_Period_1, "P1M" => CoreStrings.StoreAccount_Period_2, "P3M" => CoreStrings.StoreAccount_Period_3, "P6M" => CoreStrings.StoreAccount_Period_4, "P1Y" => CoreStrings.StoreAccount_Period_5, _ => null };
    public static string Failure(string code, int? reason = null) => code switch
    {
        "product_unknown" => CoreStrings.StoreAccount_Failure_1,
        "pass_invalid" => CoreStrings.StoreAccount_Failure_2,
        "signin_cancelled" => CoreStrings.StoreAccount_Failure_3,
        "return_not_received" => CoreStrings.LocalForm_Failure_8,
        "pass_store_unavailable" => CoreStrings.StoreAccount_Failure_5,
        _ => CoreStrings.StoreAccount_Failure_6(code, (reason is { } number ? " " + number : "")),
    };
}
