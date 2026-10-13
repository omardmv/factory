# The branch's SPA, built at base /app/, served by nginx with the API proxied
# the same way prod's host nginx does it (/app/api/... -> /api/...).
FROM node:24-alpine AS build
WORKDIR /web
COPY web/package.json web/package-lock.json ./
RUN npm ci --silent
COPY web/ ./
RUN VITE_BASE_PATH=/app/ npx vite build

FROM nginx:1.27-alpine
COPY --from=build /web/dist /usr/share/nginx/html/app
COPY --from=factory web.conf.template /etc/nginx/templates/default.conf.template
