FROM oven/bun:1.3.14-alpine@sha256:5acc90a93e91ff07bf72aa90a7c9f0fa189765aec90b47bdbf2152d2196383c0 AS build
WORKDIR /app
COPY package.json bun.lock bunfig.toml ./
RUN bun install --frozen-lockfile
COPY tsconfig.json eslint.config.js ./
COPY src ./src
RUN bun run typecheck && bun run build

FROM oven/bun:1.3.14-alpine@sha256:5acc90a93e91ff07bf72aa90a7c9f0fa189765aec90b47bdbf2152d2196383c0 AS runtime
WORKDIR /app
ENV NODE_ENV=production TRANSPORT=http HOST=0.0.0.0 PORT=3000
COPY --from=build /app/dist ./dist
COPY --from=build /app/package.json ./package.json
USER bun
EXPOSE 3000
HEALTHCHECK --interval=15s --timeout=3s --start-period=5s --retries=3 \
  CMD bun -e "const r=await fetch('http://127.0.0.1:3000/readyz');if(!r.ok)process.exit(1)"
CMD ["bun", "run", "dist/index.js", "--serve"]
