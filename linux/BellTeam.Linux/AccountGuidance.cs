namespace BellTeam.Linux;

// The Owner's two sentences (lb0220-clients, contract 1.50 s11.12): the guidance is BellTeam's own text, not the library's (0.22.1 has no LocalGuidance). Word for word on every client.
// shortcut: lives here until Anis's shared Core constant exists (windows/BellTeam.Core, his file); then these two lines are replaced by it, the strings stay the same.
internal static class AccountGuidance
{
    // First sign-in screen, before the Apple / Google buttons.
    public const string SignIn = "すでにほかの端末で使っている方は、同じアカウントでサインインしてから、次に出るQRコードを使用中の端末のカメラで読んでください。";
    // Beside the local-form QR.
    public const string Qr = "親となる端末（課金操作をするカメラのあるスマートフォンがお勧め）のカメラでQRコードを読んでください。";
}
