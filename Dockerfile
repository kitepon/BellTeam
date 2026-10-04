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
# RTK（担当ドリリー）。本家のinstall.shがsha256を照合する。~/.localはcursor-cliのvolumeで隠れるため/usr/local/binへ置く。
RUN curl -fsSL https://raw.githubusercontent.com/rtk-ai/rtk/master/install.sh | RTK_INSTALL_DIR=/usr/local/bin sh \
  && rtk --version

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

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --cache /root/.npm
COPY . .
RUN chown -R bell:bell /app

USER bell
ENV HOME=/home/bell \
  BELLTEAM_HOME=/home/bell \
  PATH=/home/bell/.local/bin:/usr/local/bin:/usr/bin:/bin \
  BELLTEAM_ROOT=/srv/bellteam \
  BELLTEAM_BOTS_CONFIG=/app/config/bots.json \
  RTK_TELEMETRY_DISABLED=1 \
  TERM=xterm-256color

CMD ["sh", "-c", "cursor-agent update && exec node src/supervisor.mjs"]
