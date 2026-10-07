# Codexのdevice code認証

出典: https://learn.chatgpt.com/docs/auth#preferred-device-code-authentication-beta
取得日: 2026-10-07
確度: OpenAI公式資料の原文。

### Preferred: Device code authentication (beta)

1. Enable device code login in your ChatGPT security settings (personal account) or ChatGPT workspace permissions (workspace admin).
2. In the terminal where you're running Codex, choose one of these options:
   - In the interactive login UI, select **Sign in with Device Code**.
   - Run `codex login --device-auth`.
3. Open the link in your browser, sign in, then enter the one-time code.

If device code login isn't available in your environment, use one of the
fallback methods below.
