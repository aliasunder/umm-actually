# Base image digest-pinned (same idiom as SHA-pinned actions in ci.yml) — the
# image builds on the consumer's runner, so a mutated tag would flow straight
# into the container that holds github_token and openrouter_api_key.
# Dependabot (docker ecosystem) keeps the digest current.

# Production dependencies — cached independently of source changes
FROM node:24-slim@sha256:3638d9a6fe4030bd716be989438248074489337ba3275657f93595428be4fc03 AS prod-deps
WORKDIR /app
COPY package.json package-lock.json ./
# --ignore-scripts: the prepare script runs husky, a devDependency absent here
RUN npm ci --omit=dev --ignore-scripts

# Build stage: dev dependencies + TypeScript compile
FROM node:24-slim@sha256:3638d9a6fe4030bd716be989438248074489337ba3275657f93595428be4fc03 AS build
WORKDIR /app
COPY package.json package-lock.json ./
# --ignore-scripts: skip husky's git-hook install — no .git in the image
RUN npm ci --ignore-scripts
COPY tsconfig.json ./
COPY src ./src
RUN npx tsc

# Runtime stage: dist + production node_modules, nothing else
FROM node:24-slim@sha256:3638d9a6fe4030bd716be989438248074489337ba3275657f93595428be4fc03
WORKDIR /app
COPY --from=prod-deps /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY package.json ./

ENTRYPOINT ["node", "/app/dist/src/main.js"]
