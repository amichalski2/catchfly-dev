FROM node:22-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
COPY apps ./apps
COPY packages ./packages
COPY patches ./patches
RUN npm ci
COPY tsconfig.json tsconfig.base.json tsconfig.node.json netlify.toml ./
COPY scripts ./scripts
COPY netlify ./netlify
COPY db ./db
RUN npm run build

FROM node:22-alpine
WORKDIR /app
ENV NODE_ENV=production PORT=8888
COPY --from=build /app/package.json /app/package-lock.json ./
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/apps/web/dist ./apps/web/dist
COPY --from=build /app/packages ./packages
COPY --from=build /app/netlify ./netlify
COPY --from=build /app/scripts ./scripts
COPY --from=build /app/db ./db
COPY --from=build /app/tsconfig.base.json /app/tsconfig.node.json ./
EXPOSE 8888
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 CMD wget -qO- http://127.0.0.1:8888/health/ready || exit 1
CMD ["sh", "scripts/docker-entrypoint.sh"]
