#!/bin/sh
# Cursor volumeだけを受け取る使い捨てコンテナの固定入口。
# 本体と共有するのはvolumeだけ。席から書ける実行ファイルへ環境を渡さない。
set -eu
exec /usr/bin/env -i HOME=/home/bell PATH=/home/bell/.local/bin:/usr/local/bin:/usr/bin:/bin \
  /home/bell/.local/bin/cursor-agent update
