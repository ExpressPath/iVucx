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
    tar \
    unzip \
    xz-utils \
    zstd \
    libgmp10; \
  rm -rf /var/lib/apt/lists/*; \
  command -v zstd; \
  if ! command -v unzstd; then ln -s "$(command -v zstd)" /usr/local/bin/unzstd; fi; \
  command -v unzstd; \
  unzstd --version; \
  tar --version

RUN set -euxo pipefail; \
  curl -L https://elan.lean-lang.org/elan-init.sh -sSf \
  | sh -s -- -y --default-toolchain "${LEAN_TOOLCHAIN}"; \
  "${ELAN_HOME}/bin/elan" --version

RUN set -euxo pipefail; \
  "${ELAN_HOME}/bin/lean" --version

WORKDIR /app
COPY package.json package-lock.json* ./
RUN set -euxo pipefail; \
  if [ -f package-lock.json ]; then npm ci --omit=dev; else npm install --omit=dev; fi

COPY . .

EXPOSE 10000
CMD ["node", "index.js"]
