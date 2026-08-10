FROM node:22-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
COPY client/package.json client/package.json
COPY server/package.json server/package.json
RUN npm ci
COPY client client
COPY server server
RUN npm run build

FROM node:22-alpine AS runtime
RUN apk add --no-cache postgresql16-client ffmpeg tini
WORKDIR /app
ENV NODE_ENV=production
COPY package.json package-lock.json ./
COPY client/package.json client/package.json
COPY server/package.json server/package.json
RUN npm ci --omit=dev && npm cache clean --force
COPY --from=build --chown=node:node /app/client/dist client/dist
COPY --chown=node:node server/src server/src
RUN mkdir -p /app/server/data && chown -R node:node /app/server/data
USER node
EXPOSE 4000
ENTRYPOINT ["/sbin/tini", "--"]
CMD ["npm", "run", "start", "--workspace", "server"]
