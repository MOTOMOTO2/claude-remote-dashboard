# The dashboard is plain ES modules — nothing to build, nothing to install.
# tools/serve.mjs is the same dependency-free static server used in
# development, so what Fly serves is what `npm run serve` serves.
FROM node:22-alpine

WORKDIR /app
COPY . .

# fly.toml publishes 8080; serve.mjs reads PORT and falls back to 5173.
ENV PORT=8080
EXPOSE 8080

CMD ["node", "tools/serve.mjs"]
