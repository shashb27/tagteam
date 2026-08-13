FROM node:20-bookworm
WORKDIR /app

# Install build tools for native modules (better-sqlite3).
# bookworm already ships python3/make/g++; we add g++ explicitly to be safe.
RUN apt-get update \
 && apt-get install -y --no-install-recommends python3 make g++ \
 && rm -rf /var/lib/apt/lists/*

COPY package*.json ./
RUN npm ci --omit=dev

COPY server/ server/
COPY web/ web/
COPY docs/ docs/

ENV PORT=3000 \
    DATA_DIR=/data \
    LOG_DIR=/logs

VOLUME ["/data", "/logs"]
EXPOSE 3000

CMD ["node", "server/index.js"]
