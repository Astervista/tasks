# Builds the Angular app and the NestJS server, then ships them on a slim runtime image.
FROM node:24-slim AS build
WORKDIR /src
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY . .
RUN npx nx run-many -t build -p server web --configuration=production --skip-nx-cache

FROM node:24-slim
ENV NODE_ENV=production \
    PORT=8080 \
    DATA_DIR=/data \
    WEB_DIR=/app/web/browser
WORKDIR /app
COPY --from=build /src/dist/apps/server/package.json /src/dist/apps/server/package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund && npm cache clean --force
COPY --from=build /src/dist/apps/server ./
COPY --from=build /src/dist/apps/web ./web
# Without a bind mount the volume inherits this ownership; compose runs as the host user instead
RUN mkdir -p /data && chown node:node /data
USER node
VOLUME /data
EXPOSE 8080
# Up = the API answers: 200 in proxy mode (no token needed), 401 in token mode
HEALTHCHECK --interval=30s --timeout=5s CMD node -e "fetch('http://127.0.0.1:'+process.env.PORT+'/api/current').then(r=>process.exit(r.status===200||r.status===401?0:1),()=>process.exit(1))"
CMD ["node", "main.js"]
