FROM node:22-alpine AS build

WORKDIR /repo

COPY package.json package-lock.json tsconfig.base.json ./
COPY packages/shared/package.json ./packages/shared/
COPY apps/web/package.json ./apps/web/

RUN npm ci --workspaces --include-workspace-root --ignore-scripts

COPY packages/shared ./packages/shared
COPY apps/web ./apps/web

ARG VITE_API_BASE_URL
ENV VITE_API_BASE_URL=${VITE_API_BASE_URL}

RUN npm run build --workspace @rpow/shared -- --force
RUN rm -rf node_modules/@rpow/shared \
  && mkdir -p node_modules/@rpow/shared \
  && cp packages/shared/package.json node_modules/@rpow/shared/package.json \
  && cp -R packages/shared/dist node_modules/@rpow/shared/dist
RUN npx tsc -b apps/web --force && cd apps/web && npx --no-install vite build

FROM nginx:1.27-alpine

COPY apps/web/nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /repo/apps/web/dist /usr/share/nginx/html

EXPOSE 80
