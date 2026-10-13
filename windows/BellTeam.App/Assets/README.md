# Windowsのアプリアイコン

`BellTeam.ico`は共通の`ios/BellBot/BellBot/Assets.xcassets/AppIcon.appiconset/bellbot-icon.png`からWindows用に変換した32bitのアイコン。16・20・24・32・40・48・64pxはDIB、256pxはPNGで格納する。`pwsh -NoProfile -File scripts/build-windows-icon.ps1`で再生成できる。元のブランド画像は変更しない。ウィンドウ用のPNGは同じファイルをプロジェクトのResourceとして参照する。
