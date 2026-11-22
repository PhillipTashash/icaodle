FROM node:22-alpine
ENV NODE_ENV=production PORT=3000 DATA_FILE=/data/data.json
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY server.js index.html style.css sfx.mjs airports.json ./
COPY sounds ./sounds
# the saved daily sets and scores live in /data (a volume), so they survive restarts and image updates
RUN mkdir -p /data && chown node:node /data
USER node
VOLUME /data
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s CMD wget -q -O /dev/null http://127.0.0.1:${PORT}/api/states || exit 1
CMD ["node", "server.js"]
