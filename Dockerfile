# Base image digest-pinned (same idiom as SHA-pinned actions in ci.yml) — the
# image builds on the consumer's runner, so a mutated tag would flow straight
# into the container that holds github_token and openrouter_api_key.
# Dependabot (docker ecosystem) keeps the digest current.

# Production dependencies — cached independently of source changes
FROM node:24-slim@sha256:dc26ae92c9fb15cf6b1d63e20f0944b2efe0f115b20e00be48fb23fceb061c54 AS prod-deps
WORKDIR /app
COPY package.json package-lock.json ./
# --ignore-scripts: the prepare script runs husky, a devDependency absent here
RUN npm ci --omit=dev --ignore-scripts

# Build stage: dev dependencies + TypeScript compile
FROM node:24-slim@sha256:dc26ae92c9fb15cf6b1d63e20f0944b2efe0f115b20e00be48fb23fceb061c54 AS build
WORKDIR /app
COPY package.json package-lock.json ./
# --ignore-scripts: skip husky's git-hook install — no .git in the image
RUN npm ci --ignore-scripts
COPY tsconfig.json ./
COPY src ./src
RUN npx tsc

# Runtime stage: dist + production node_modules, nothing else
FROM node:24-slim@sha256:dc26ae92c9fb15cf6b1d63e20f0944b2efe0f115b20e00be48fb23fceb061c54
WORKDIR /app
COPY --from=prod-deps /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY package.json ./

ENTRYPOINT ["node", "--enable-source-maps", "/app/dist/src/main.js"]
