# Build Flowform web, serve static on port 5180 (not 5173 — Ritara).
FROM node:22-alpine AS build

WORKDIR /app

ARG VITE_API_URL=http://127.0.0.1:5182
ENV VITE_API_URL=$VITE_API_URL

COPY apps/web/package.json apps/web/package-lock.json ./
RUN npm ci

COPY apps/web/ ./
RUN npm run build

FROM nginx:1.27-alpine

COPY apps/web/docker/nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /app/dist /usr/share/nginx/html

EXPOSE 5180

CMD ["nginx", "-g", "daemon off;"]
