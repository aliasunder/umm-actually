# Production dependencies — cached independently of source changes
FROM node:24-slim AS prod-deps
WORKDIR /app
COPY package.json package-lock.json ./
# --ignore-scripts: the prepare script runs husky, a devDependency absent here
RUN npm ci --omit=dev --ignore-scripts

# Build stage: dev dependencies + TypeScript compile
FROM node:24-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
# --ignore-scripts: skip husky's git-hook install — no .git in the image
RUN npm ci --ignore-scripts
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
