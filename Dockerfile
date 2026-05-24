FROM node:22-alpine AS web-build
WORKDIR /app
COPY web/package*.json ./web/
RUN cd web && npm ci
COPY web ./web
RUN cd web && npm run build

FROM node:22-alpine
WORKDIR /app
ENV NODE_ENV=production
ENV DEVSYNC_SELF_HOSTED=true
ENV HOST=0.0.0.0
ENV PORT=4000
ENV DEVSYNC_DATA_ROOT=/data
ENV DEVSYNC_VAULT_NAME=devsync-vault
ENV DEVSYNC_WEB_DIST=/app/web/dist
RUN apk add --no-cache git
COPY package*.json ./
RUN npm ci --omit=dev --ignore-scripts \
  && npm cache clean --force \
  && rm -rf /usr/local/lib/node_modules/npm /usr/local/bin/npm /usr/local/bin/npx
COPY --chown=node:node server ./server
COPY --from=web-build --chown=node:node /app/web/dist ./web/dist
RUN mkdir -p /data && chown -R node:node /data
USER node
EXPOSE 4000
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 CMD node -e "fetch('http://127.0.0.1:' + (process.env.PORT || 4000) + '/api/health').then((r) => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1))"
CMD ["node", "server/src/index.js"]
