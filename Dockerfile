FROM node:20-bookworm-slim

ENV NODE_ENV=production
ENV ELAN_HOME=/opt/elan
ENV PATH="${ELAN_HOME}/bin:${PATH}"

ARG LEAN_TOOLCHAIN=stable
ENV LEAN_TOOLCHAIN=${LEAN_TOOLCHAIN}

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
    libgmp10 \
  && rm -rf /var/lib/apt/lists/*

RUN curl -L https://elan.lean-lang.org/elan-init.sh -sSf \
  | sh -s -- -y --default-toolchain "${LEAN_TOOLCHAIN}"

RUN lean --version

WORKDIR /app
COPY package.json package-lock.json* ./
RUN if [ -f package-lock.json ]; then npm ci --omit=dev; else npm install --omit=dev; fi

COPY . .

EXPOSE 3000
CMD ["node", "index.js"]
