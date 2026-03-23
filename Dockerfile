FROM node:20-slim AS builder

RUN apt-get update && apt-get install -y python3 make g++ && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package.json ./
RUN npm install --production=false

COPY tsconfig.json ./
COPY src/ src/
RUN npx tsc

# ---- Production image ----
FROM node:20-slim

RUN apt-get update && apt-get install -y python3 make g++ \
    && useradd -r -m -d /home/mcpuser -s /bin/false mcpuser \
    && mkdir -p /app/data \
    && chown -R mcpuser:mcpuser /app

WORKDIR /app

COPY package.json ./
RUN npm install --omit=dev && npm cache clean --force \
    && apt-get purge -y python3 make g++ && apt-get autoremove -y && rm -rf /var/lib/apt/lists/*

COPY --from=builder /app/dist/ dist/

ENV MCP_TRANSPORT=streamable-http
ENV MCP_HOST=0.0.0.0
ENV MCP_PORT=8642
ENV EXERCITATOR_DB_PATH=/app/data/exercitator.db
ENV HOME=/home/mcpuser

EXPOSE 8642

USER mcpuser

HEALTHCHECK --interval=60s --timeout=3s --start-period=10s \
    CMD node -e "const s=require('net').createConnection(8642,'localhost');s.on('connect',()=>{s.end();process.exit(0)});s.on('error',()=>process.exit(1))"

CMD ["node", "dist/index.js"]
