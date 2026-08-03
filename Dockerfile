FROM node:22-alpine AS builder
WORKDIR /app
COPY package*.json ./
COPY packages/shared/package.json ./packages/shared/
COPY packages/builder/package.json ./packages/builder/
# The root postinstall runs scripts/link-libsodium.mjs, so that script has to be
# present before `npm ci`, not with the later source COPY. It is fail-loud by
# design (the old shell one-liner ended in `|| true` and silently no-opped), so a
# missing script fails the build here rather than shipping a broken image.
COPY scripts/ ./scripts/
RUN npm ci
COPY packages/ ./packages/
RUN npm run build

FROM node:22-alpine
WORKDIR /app
COPY package*.json ./
COPY packages/shared/package.json ./packages/shared/
COPY packages/builder/package.json ./packages/builder/
# Same reason as the builder stage: postinstall needs this before `npm ci`.
COPY scripts/ ./scripts/
RUN npm ci --omit=dev
COPY --from=builder /app/packages/builder/build/ ./packages/builder/build/
EXPOSE 3000
CMD ["node", "packages/builder/build/index.js"]
