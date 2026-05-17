FROM oven/bun:1.3.14-alpine AS builder
WORKDIR /app
COPY . .
RUN bun install --frozen-lockfile && bun run build:dist

FROM oven/bun:1.3.14-alpine
WORKDIR /app
COPY --from=builder /app/iquantum-cli/dist/daemon.js ./daemon.js
COPY --from=builder /app/iquantum-cli/dist/*.wasm ./
COPY --from=builder /app/iquantum-cli/dist/*.node* ./
EXPOSE 51820
ENV IQUANTUM_SOCKET=/tmp/daemon.sock
CMD ["bun", "daemon.js"]
