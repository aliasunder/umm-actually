# Build stage: compile TypeScript with dev dependencies present
FROM node:24-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json ./
COPY src ./src
RUN npx tsc

# Prune to production dependencies only
RUN npm ci --omit=dev

# Runtime stage: dist + production node_modules, nothing else
FROM node:24-slim
WORKDIR /app
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY --from=build /app/package.json ./package.json

ENTRYPOINT ["node", "/app/dist/src/main.js"]
