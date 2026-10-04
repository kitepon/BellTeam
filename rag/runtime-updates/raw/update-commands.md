# 現行版の導入に使う公式仕様の原文抜粋

出典: [Docker Compose build](https://docs.docker.com/reference/cli/docker/compose/build/)、[Node公式Dockerイメージ](https://hub.docker.com/_/node)、[Node配布方針](https://github.com/nodejs/node/blob/main/doc/contributing/distribution.md)、[npm dist-tag](https://docs.npmjs.com/cli/v11/commands/npm-dist-tag/)、[Corepack README](https://github.com/nodejs/corepack/blob/main/README.md)、[Cursor CLI Installation](https://docs.cursor.com/en/cli/installation)。取得日: 2026-09-27。確度: 各製品の公式資料。

## Docker Compose

> `--no-cache` — Do not use cache when building the image
>
> `--pull` — Always attempt to pull a newer version of the image

## Node公式Dockerイメージ

> `26-bookworm`, `26.8-bookworm`, `26.8.2-bookworm`, `bookworm`, `current-bookworm`

## npm

> By default, `npm install <pkg>` (without any `@<version>` or `@<tag>` specifier) installs the `latest` tag.

## Corepack

> It is no longer distributed as of Node.js 25.0.0.
>
> To install the latest version of Corepack, use:
>
> `npm install -g corepack@latest`

## Cursor CLI

> Cursor CLI will try to auto-update by default to ensure you always have the latest version. To manually update Cursor CLI to the latest version:
>
> `cursor-agent update`
