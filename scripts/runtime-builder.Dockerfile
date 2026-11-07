FROM node:26-trixie

RUN apt-get update \
 && apt-get install -y --no-install-recommends python3 build-essential pkg-config \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /work
