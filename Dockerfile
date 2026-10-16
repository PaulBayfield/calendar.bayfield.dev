# Web build + scheduling server in one image.
#   docker build --build-arg VITE_GOOGLE_WEB_CLIENT_ID=... -t calendar .
#   docker run -p 8787:8787 -v calendar-data:/data --env-file server/.env calendar

FROM node:25-alpine AS web
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY index.html book.html vite.config.ts tsconfig.json tsconfig.node.json ./
COPY src ./src
COPY public ./public
# The web OAuth client ID is public (it ships in the JS bundle anyway).
ARG VITE_GOOGLE_WEB_CLIENT_ID
ARG VITE_GOOGLE_MAPS_API_KEY
ENV VITE_GOOGLE_WEB_CLIENT_ID=$VITE_GOOGLE_WEB_CLIENT_ID \
    VITE_GOOGLE_MAPS_API_KEY=$VITE_GOOGLE_MAPS_API_KEY
RUN npm run build

FROM node:25-alpine
WORKDIR /app/server
COPY server/package.json server/package-lock.json ./
RUN npm ci --omit=dev
COPY server/src ./src
COPY --from=web /app/dist /app/dist
ENV NODE_ENV=production \
    PORT=8787 \
    DATA_DIR=/data \
    DIST_DIR=/app/dist
VOLUME /data
EXPOSE 8787
USER node
CMD ["node", "src/index.ts"]
