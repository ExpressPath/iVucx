FROM node:20-bookworm-slim

ENV NODE_ENV=production
ENV ELAN_HOME=/opt/elan
ENV PATH="${ELAN_HOME}/bin:${PATH}"

ARG LEAN_TOOLCHAIN=stable
ENV LEAN_TOOLCHAIN=${LEAN_TOOLCHAIN}

# 必要パッケージ（zstd を追加）
RUN apt-get update \
  && apt-get install -y --no-install-recommends \
    bash \
    ca-certificates \
    curl \
    git \
    tar \
    unzip \
    xz-utils \
    zstd \
    wget \
    libgmp10 \
  && rm -rf /var/lib/apt/lists/*

# elan インストール（ELAN_HOME を使用）
RUN curl -L https://elan.lean-lang.org/elan-init.sh -sSf \
  | sh -s -- -y --default-toolchain "${LEAN_TOOLCHAIN}"

# 明示的に toolchain をインストール（冪等）
RUN "${ELAN_HOME}/bin/elan" toolchain install "${LEAN_TOOLCHAIN}" || true

# toolchain 中の lean 実バイナリへの symlink を作る（どのバージョンでも動く）
RUN set -eux; \
    LEAN_BIN=$(find "${ELAN_HOME}/toolchains" -maxdepth 2 -type f -name lean -print -quit) ; \
    if [ -n "$LEAN_BIN" ]; then ln -sf "$LEAN_BIN" /usr/local/bin/lean; fi

# 確認（ビルドログに Lean バージョンを出す）
RUN if command -v lean >/dev/null 2>&1; then lean --version; else echo "lean NOT found"; fi

WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm ci --omit=dev

COPY . .

EXPOSE 3000
CMD ["node", "index.js"]