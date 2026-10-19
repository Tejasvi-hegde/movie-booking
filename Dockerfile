# One Dockerfile for every backend service:  docker build --build-arg SERVICE=booking .
# Stage 1 installs everything and bundles the chosen service (its code + @showtime/common) with tsup.
# Stage 2 ships only production dependencies, the bundle and the SQL migrations.
FROM node:22-alpine AS build
WORKDIR /app
COPY package.json package-lock.json tsconfig.base.json tsup.base.ts ./
COPY packages/common/package.json packages/common/
COPY services/gateway/package.json services/gateway/
COPY services/auth/package.json services/auth/
COPY services/catalog/package.json services/catalog/
COPY services/booking/package.json services/booking/
COPY services/payment/package.json services/payment/
COPY services/notification/package.json services/notification/
COPY frontend/package.json frontend/
RUN npm ci --no-audit --no-fund
COPY packages packages
COPY services services
ARG SERVICE
RUN test -n "$SERVICE" && npm run build -w services/$SERVICE

FROM node:22-alpine AS deps
WORKDIR /app
COPY --from=build /app/package.json /app/package-lock.json ./
COPY --from=build /app/packages/common/package.json packages/common/
COPY --from=build /app/services/gateway/package.json services/gateway/
COPY --from=build /app/services/auth/package.json services/auth/
COPY --from=build /app/services/catalog/package.json services/catalog/
COPY --from=build /app/services/booking/package.json services/booking/
COPY --from=build /app/services/payment/package.json services/payment/
COPY --from=build /app/services/notification/package.json services/notification/
COPY --from=build /app/frontend/package.json frontend/
# Frontend packages are all devDependencies, so they are skipped here.
RUN npm ci --omit=dev --no-audit --no-fund

FROM node:22-alpine
ARG SERVICE
ENV NODE_ENV=production SERVICE=${SERVICE}
WORKDIR /app
COPY --from=deps /app/node_modules node_modules
# The service folder brings dist/, package.json and migrations/ (for services that have them).
COPY --from=build /app/services/${SERVICE} services/${SERVICE}
WORKDIR /app/services/${SERVICE}
USER node
CMD ["node", "--enable-source-maps", "dist/index.js"]
