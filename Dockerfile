# mcp-lazy（MCPを使う時だけ本体を起こす中継。担当レオナ）。npmの同名パッケージは別の製品なので、公開リポジトリの最新mainからビルドする（Owner 2026-11-08: 同梱物は固定しない）。
FROM golang:trixie AS mcp-lazy
RUN git clone --depth 1 https://github.com/kitepon/mcp-lazy.git /src \
  && cd /src \
  && CGO_ENABLED=0 go build -buildvcs=false -trimpath -ldflags '-s -w' -o /out/mcp-lazy .

FROM docker:cli AS docker-client

FROM node:current-trixie AS harnesses

SHELL ["/bin/bash", "-o", "pipefail", "-c"]

RUN apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates curl git procps tmux \
     sudo python3 python3-pip python3-venv python3-dev build-essential pkg-config \
     cmake rsync ripgrep jq zip unzip \
  && mkdir -p -m 755 /etc/apt/keyrings \
  && curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg -o /etc/apt/keyrings/githubcli-archive-keyring.gpg \
  && chmod go+r /etc/apt/keyrings/githubcli-archive-keyring.gpg \
  && printf 'deb [arch=%s signed-by=/etc/apt/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main\n' "$(dpkg --print-architecture)" > /etc/apt/sources.list.d/github-cli.list \
  && apt-get update \
  && apt-get install -y --no-install-recommends gh \
  && rm -rf /var/lib/apt/lists/*

RUN npm install --global corepack@latest @openai/codex@latest @anthropic-ai/claude-code@latest throughline@latest aiterm-mcp@latest \
  && corepack --version && codex --version && claude --version && throughline --version \
  && node -e 'for (const name of ["aiterm-mcp"]) console.log(name, require("/usr/local/lib/node_modules/" + name + "/package.json").version)'
RUN curl -fsSL https://x.ai/cli/install.sh | bash \
  && install -m 0755 /root/.grok/bin/grok /usr/local/bin/grok \
  && grok --version
RUN curl -fsSL https://antigravity.google/cli/install.sh | bash -s -- --dir /usr/local/bin \
  && agy --version
# RTK（担当ドリリー）。本家のinstall.shがsha256を照合する。~/.localはcursor-cliのvolumeで隠れるため/usr/local/binへ置く。
# 版を固定する: 最新版の検索はGitHub APIを使い、CIの共有IPでは回数制限で失敗する（2026-11-08）。版の更新はドリリー。
ARG RTK_VERSION=v1.2.0
RUN curl -fsSL https://raw.githubusercontent.com/rtk-ai/rtk/master/install.sh | RTK_VERSION=$RTK_VERSION RTK_INSTALL_DIR=/usr/local/bin sh \
  && rtk --version
# 1Password CLI for the usage module (UID1001, fixed PATH /usr/local/bin). Latest from 1Password's update feed (no GitHub API);
# the binary runs only after its signature matches 1Password's signing key (fingerprint per developer.1password.com/docs/cli/get-started).
ARG TARGETARCH
RUN set -eu; arch=${TARGETARCH:-$(dpkg --print-architecture)}; work=$(mktemp -d); export GNUPGHOME=$work/g; mkdir -m 700 $GNUPGHOME \
  && version=$(curl -fsSL https://app-updates.agilebits.com/check/1/0/CLI2/en/2.0.0/N | node -e 'const v=JSON.parse(require("fs").readFileSync(0)).version;if(!/^\d+\.\d+\.\d+$/.test(v))process.exit(1);console.log(v)') \
  && curl -fsSL -o $work/op.zip "https://cache.agilebits.com/dist/1P/op2/pkg/v$version/op_linux_${arch}_v$version.zip" \
  && curl -fsSL -o $work/key.asc https://downloads.1password.com/linux/keys/1password.asc \
  && unzip -q $work/op.zip op op.sig -d $work && gpg -q --batch --import $work/key.asc \
  && gpg --batch --status-fd 1 --verify $work/op.sig $work/op 2>/dev/null | grep -Eq '^\[GNUPG:\] VALIDSIG .* 3FEF9748469ADBE15DA7CA80AC2D62742012EA22$' \
  && install -o root -g root -m 0755 $work/op /usr/local/bin/op && rm -rf $work && op --version
COPY --from=mcp-lazy /out/mcp-lazy /usr/local/bin/mcp-lazy
RUN mcp-lazy --version

RUN usermod -l bell -d /home/bell -m node \
  && groupmod -n bell node \
  && printf 'bell ALL=(ALL:ALL) NOPASSWD: ALL\n' > /etc/sudoers.d/bell \
  && chmod 0440 /etc/sudoers.d/bell

USER bell
ENV HOME=/home/bell \
  PATH=/home/bell/.local/bin:/usr/local/bin:/usr/bin:/bin
RUN curl https://cursor.com/install -fsS | bash \
  && cursor-agent --version

FROM harnesses AS server
USER root

COPY --from=docker-client /usr/local/bin/docker /usr/local/bin/docker
COPY --from=docker-client /usr/local/libexec/docker/cli-plugins/docker-compose /usr/local/libexec/docker/cli-plugins/docker-compose
RUN docker --version && docker compose version

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --cache /root/.npm
COPY . .
COPY distribution/server/install-resume-state.sh distribution/server/compose.aiterm-checkpoint.yaml ./
RUN install -o root -g root -m 0755 scripts/cursor-update-entrypoint.sh /usr/local/bin/bellteam-update-cursor
RUN /usr/sbin/groupadd -g 1001 bellteam-server \
  && /usr/sbin/useradd -u 1001 -g 1001 -d /run/bellteam-server -M -s /usr/sbin/nologin bellteam-server \
  && mkdir -p /usr/local/libexec \
  && cc -O2 -Wall -Wextra -Werror scripts/seat-exec.c -o /usr/local/libexec/bellteam-seat-exec \
  && cc -O2 -Wall -Wextra -Werror scripts/server-start.c -o /usr/local/libexec/bellteam-server-start \
  && cc -O2 -Wall -Wextra -Werror scripts/notifications-start.c -o /usr/local/libexec/bellteam-notifications-start \
  && cc -O2 -Wall -Wextra -Werror scripts/members-start.c -o /usr/local/libexec/bellteam-members-start \
  && cc -O2 -Wall -Wextra -Werror scripts/usage-start.c -o /usr/local/libexec/bellteam-usage-start \
  && cc -O2 -Wall -Wextra -Werror scripts/diagnostics-start.c -o /usr/local/libexec/bellteam-diagnostics-start \
  && cc -O2 -Wall -Wextra -Werror scripts/conversation-start.c -o /usr/local/libexec/bellteam-conversation-start \
  && cc -O2 -Wall -Wextra -Werror scripts/work-graph-start.c -o /usr/local/libexec/bellteam-work-graph-start \
  && chown root:root /usr/local/libexec/bellteam-notifications-start /usr/local/libexec/bellteam-members-start /usr/local/libexec/bellteam-usage-start /usr/local/libexec/bellteam-diagnostics-start /usr/local/libexec/bellteam-conversation-start /usr/local/libexec/bellteam-work-graph-start \
  && chmod 0755 /usr/local/libexec/bellteam-notifications-start /usr/local/libexec/bellteam-members-start /usr/local/libexec/bellteam-usage-start /usr/local/libexec/bellteam-diagnostics-start /usr/local/libexec/bellteam-conversation-start /usr/local/libexec/bellteam-work-graph-start \
  && chown root:root /usr/local/libexec/bellteam-seat-exec /usr/local/libexec/bellteam-server-start \
  && chmod 0755 /usr/local/libexec/bellteam-seat-exec /usr/local/libexec/bellteam-server-start \
  && printf 'bellteam-server ALL=(root) NOPASSWD: /usr/local/libexec/bellteam-seat-exec -- *\n' > /etc/sudoers.d/bellteam-server \
  && chmod 0440 /etc/sudoers.d/bellteam-server \
  && chown -R root:root /app

USER bellteam-server
ENV HOME=/run/bellteam-server \
  BELLTEAM_HOME=/home/bell \
  PATH=/usr/local/bin:/usr/bin:/bin \
  BELLTEAM_ROOT=/srv/bellteam \
  BELLTEAM_BOTS_CONFIG=/app/config/bots.json \
  RTK_TELEMETRY_DISABLED=1 \
  RTK_SUPPRESS_HOOK_WARNING=1 \
  TERM=xterm-256color

ENTRYPOINT ["/usr/local/libexec/bellteam-server-start"]
CMD []
