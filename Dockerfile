FROM node:22.17.0-bookworm-slim@sha256:b04ce4ae4e95b522112c2e5c52f781471a5cbc3b594527bcddedee9bc48c03a0 AS lean-runtime

ENV DEBIAN_FRONTEND=noninteractive
ENV ELAN_HOME=/opt/elan
ENV PATH=/opt/elan/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
ARG LEAN_TOOLCHAIN=leanprover/lean4:v4.30.0
ARG ELAN_COMMIT=464c9d28395000a2a0128e07081e4956d50eced2
ENV LEAN_TOOLCHAIN=${LEAN_TOOLCHAIN}

RUN apt-get update \
  && apt-get install -y --no-install-recommends \
    ca-certificates \
    curl \
    xz-utils \
    zstd \
  && rm -rf /var/lib/apt/lists/*

RUN curl --fail --show-error --silent --retry 3 \
    "https://raw.githubusercontent.com/leanprover/elan/${ELAN_COMMIT}/elan-init.sh" \
    | sh -s -- -y --default-toolchain "${LEAN_TOOLCHAIN}" --no-modify-path

RUN /opt/elan/bin/lean --version

FROM lean-runtime AS lean4export-builder
ARG LEAN4EXPORT_COMMIT=a3e35a584f59b390667db7269cd37fca8575e4bf

RUN apt-get update \
  && apt-get install -y --no-install-recommends \
    build-essential \
    git \
  && rm -rf /var/lib/apt/lists/*

RUN git init /opt/lean4export \
  && cd /opt/lean4export \
  && git remote add origin https://github.com/leanprover/lean4export \
  && git fetch --depth=1 origin "${LEAN4EXPORT_COMMIT}" \
  && git checkout --detach FETCH_HEAD \
  && lake build

FROM ocaml/opam:debian-12-ocaml-4.14@sha256:5a332df4b3c8791acc44a81fe82b268704442588e5e368ab9f50828b1a549fcb AS metarocq-builder

USER root
RUN apt-get update \
  && apt-get install -y --no-install-recommends \
    bubblewrap \
    build-essential \
    ca-certificates \
    git \
    libgmp-dev \
    m4 \
    patch \
    pkg-config \
    rsync \
    unzip \
    zstd \
  && rm -rf /var/lib/apt/lists/*

USER opam
RUN opam switch create ivucx 4.14.2
RUN opam repo add -y --switch=ivucx rocq-released https://rocq-prover.org/opam/released
RUN opam update --switch=ivucx
RUN opam install -y --verbose --switch=ivucx \
  rocq-core=9.1.1 \
  rocq-stdlib=9.1.0 \
  rocq-metarocq-template=1.5.1+9.1

FROM node:22.17.0-bookworm-slim@sha256:b04ce4ae4e95b522112c2e5c52f781471a5cbc3b594527bcddedee9bc48c03a0

ENV DEBIAN_FRONTEND=noninteractive
ENV ELAN_HOME=/opt/elan
ENV OPAM_SWITCH_PREFIX=/home/opam/.opam/ivucx
ENV PATH=/home/opam/.opam/ivucx/bin:/opt/elan/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin

RUN apt-get update \
  && apt-get install -y --no-install-recommends \
    ca-certificates \
    bubblewrap \
    dumb-init \
    libffi8 \
    libgmp10 \
    libstdc++6 \
    util-linux \
    zlib1g \
  && rm -rf /var/lib/apt/lists/*

RUN groupadd --gid 10001 ivucx \
  && useradd --uid 10001 --gid 10001 --create-home --home-dir /home/ivucx --shell /usr/sbin/nologin ivucx

COPY --from=lean-runtime --chown=root:ivucx /opt/elan /opt/elan
COPY --from=lean4export-builder --chown=root:ivucx /opt/lean4export/.lake/build/bin/lean4export /usr/local/bin/lean4export
COPY --from=metarocq-builder --chown=root:ivucx /home/opam/.opam/ivucx /home/opam/.opam/ivucx
RUN chmod -R g+rX /opt/elan /home/opam/.opam/ivucx \
  && chmod 0755 /usr/local/bin/lean4export

WORKDIR /app

COPY package.json package-lock.json* ./
RUN if [ -f package-lock.json ]; then npm ci --omit=dev; else npm install --omit=dev; fi

COPY . .
RUN node server-tools/cic-smoke-test.cjs
RUN chown -R root:root /app \
  && chmod -R go-w /app

ENV NODE_ENV=production
ENV PORT=10000
ENV LEAN_TOOLCHAIN=leanprover/lean4:v4.30.0
ENV LEAN_CMD=lean
ENV COQ_CMD=/home/opam/.opam/ivucx/bin/coqc
ENV IVUCX_LEAN_CMD=/opt/elan/bin/lean
ENV IVUCX_COQ_CMD=/home/opam/.opam/ivucx/bin/coqc
ENV LEAN_LAMBDA_CMD=node
ENV LEAN_LAMBDA_ARGS="/app/server-tools/convert-lean.cjs --out {out}"
ENV COQ_LAMBDA_CMD=node
ENV COQ_LAMBDA_ARGS="/app/server-tools/convert-coq.cjs --out {out}"
ENV LEAN_CIC_CMD=node
ENV LEAN_CIC_ARGS="/app/server-tools/convert-lean-cic.cjs --out {out}"
ENV COQ_CIC_CMD=node
ENV COQ_CIC_ARGS="/app/server-tools/convert-coq-cic.cjs --out {out}"
ENV LEAN4EXPORT_BIN=/usr/local/bin/lean4export
ENV LEAN4EXPORT_CMD=lake
ENV LEAN4EXPORT_ARGS="env {bin} {module}"
ENV HOME=/home/ivucx
ENV IVUCX_PROOF_SANDBOX_REQUIRED=true
ENV IVUCX_PROOF_SANDBOX_CMD=/usr/bin/bwrap
ENV IVUCX_PROOF_LIMIT_CMD=/usr/bin/prlimit

EXPOSE 10000

USER 10001:10001

ENTRYPOINT ["dumb-init", "--"]
CMD ["node", "index.js"]
