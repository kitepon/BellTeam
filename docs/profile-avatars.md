# 小・大アバターと再調整用画像

既存の`avatar`は小アバターの描画済みdata URLで、既存client・通知cache・`/avatar`の意味を維持する。新しい任意fieldは次のとおり。旧プロフィールは空画像/null矩形として読める。

| field | 保存する内容 |
| --- | --- |
| avatarLarge | 大アバターの描画済み画像。空なら表示は常に現在のavatarへ追従 |
| avatarSource / avatarLargeSource | 各画像の未切抜きsource data URL |
| avatarCrop / avatarLargeCrop | 各sourceに対する左上原点の正規化矩形{x,y,width,height}、又はnull |

各画像は既avatarと同じPNG/JPEG/WebP/GIF data URL・3,000,000文字以下。HTTP JSON上限16MiB以内で送る。矩形は有限数、x/y>=0、width/height>0、右下が1以内。浮動小数の端数1e-9だけ許容する。新選択/再調整は対応するrender/source/cropの3fieldを一回のPATCHへ含める。sourceが無ければcropはnull。欠測元画像の外側は復元しない。

無関係なPATCH・旧clientによる省略は新画像情報を保持する。旧clientがrenderだけを別値へ変更すると、その画像の古いsource/cropを空/nullにする。小だけ変更しても独立設定済みの大画像は変えない。大renderを空にすると現在の小への追従に戻る。

編集時の既`GET /api/bots/:id`は新fieldを含む`{bot:...}`を返す。通常一覧は`avatarLargeVersion/avatarSourceVersion/avatarLargeSourceVersion`とcrop情報も返し、`?avatar=omit`で小・大・元画像すべての本文を除く。大画像の版は実表示する画像（独立画像又は小fallback）のhashに対応する。小通知cacheは従来どおり。

認証付き`/api/bots/:id/avatar-large`、`/avatar-source`、`/avatar-large-source`は既avatarと同じETag/版付きURL cache契約で返す。未保存sourceは404、未保存largeは小にfallbackする。席MCPのプロフィール返答からはこれらの画像本文も除外する。
