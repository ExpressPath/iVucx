FROM node:20-bookworm-slim

ENV NODE_ENV=production

RUN apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY services/railway-helper/package.json ./
RUN npm install --omit=dev
COPY services/railway-helper ./

EXPOSE 3000
CMD ["node", "index.js"]
