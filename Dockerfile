FROM node:22-alpine AS builder
WORKDIR /app
COPY package*.json ./
COPY packages/shared/package.json ./packages/shared/
COPY packages/builder/package.json ./packages/builder/
RUN npm ci
COPY packages/ ./packages/
RUN npm run build

FROM node:22-alpine
WORKDIR /app
COPY package*.json ./
COPY packages/shared/package.json ./packages/shared/
COPY packages/builder/package.json ./packages/builder/
RUN npm ci --omit=dev
COPY --from=builder /app/packages/builder/build/ ./packages/builder/build/
EXPOSE 3000
CMD ["node", "packages/builder/build/index.js"]
