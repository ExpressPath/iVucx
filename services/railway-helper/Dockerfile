FROM node:20-bookworm-slim

SHELL ["/bin/bash", "-lc"]

ENV NODE_ENV=production
ENV ELAN_HOME=/opt/elan
ENV PATH="/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin:${ELAN_HOME}/bin"
ARG LEAN_TOOLCHAIN=stable
ENV LEAN_TOOLCHAIN=${LEAN_TOOLCHAIN}

RUN set -euxo pipefail; \
  apt-get update; \
  apt-get install -y --no-install-recommends \
    bash \
    ca-certificates \
    coq \
    curl \
    git \
    libgmp10 \
    tar \
    unzip \
    xz-utils \
    zstd; \
  rm -rf /var/lib/apt/lists/*

RUN set -euxo pipefail; \
  curl -L https://elan.lean-lang.org/elan-init.sh -sSf \
    | sh -s -- -y --default-toolchain "${LEAN_TOOLCHAIN}"; \
  "${ELAN_HOME}/bin/lean" --version

WORKDIR /app
COPY services/railway-helper/package.json ./
RUN npm install --omit=dev
COPY services/railway-helper ./

EXPOSE 3000
CMD ["node", "index.js"]
