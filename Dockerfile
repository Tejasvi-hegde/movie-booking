# One Dockerfile for every backend service:  docker build --build-arg SERVICE=booking .
# The code is plain JavaScript, so there is no build step: install production dependencies,
# copy the shared package and the chosen service, and run it with node.
FROM node:22-alpine AS deps
WORKDIR /app
COPY package.json package-lock.json ./
COPY packages/common/package.json packages/common/
COPY services/gateway/package.json services/gateway/
COPY services/auth/package.json services/auth/
COPY services/catalog/package.json services/catalog/
COPY services/booking/package.json services/booking/
COPY services/payment/package.json services/payment/
COPY services/notification/package.json services/notification/
COPY frontend/package.json frontend/
# Frontend packages are all devDependencies, so they are skipped here.
RUN npm ci --omit=dev --no-audit --no-fund

FROM node:22-alpine
ARG SERVICE
RUN test -n "$SERVICE"
ENV NODE_ENV=production SERVICE=${SERVICE}
WORKDIR /app
COPY --from=deps /app/node_modules node_modules
COPY package.json ./
COPY packages/common packages/common
# The service folder brings src/, package.json and migrations/ (for services that have them).
COPY services/${SERVICE} services/${SERVICE}
WORKDIR /app/services/${SERVICE}
USER node
CMD ["node", "src/index.js"]
