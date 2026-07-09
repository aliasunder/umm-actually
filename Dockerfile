# Production dependencies — cached independently of source changes
FROM node:24-slim AS prod-deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

# Build stage: dev dependencies + TypeScript compile
FROM node:24-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json ./
COPY src ./src
RUN npx tsc

# Runtime stage: dist + production node_modules, nothing else
FROM node:24-slim
WORKDIR /app
COPY --from=prod-deps /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY package.json ./

ENTRYPOINT ["node", "/app/dist/src/main.js"]
