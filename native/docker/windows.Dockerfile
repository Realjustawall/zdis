FROM node:24-bookworm-slim AS node
FROM electronuserland/builder:wine
COPY --from=node /usr/local/bin/node /usr/local/bin/node
COPY --from=node /usr/local/lib/node_modules /usr/local/lib/node_modules
RUN ln -sf /usr/local/lib/node_modules/npm/bin/npm-cli.js /usr/local/bin/npm && ln -sf /usr/local/lib/node_modules/npm/bin/npx-cli.js /usr/local/bin/npx \
    && groupadd --gid 10001 zdisbuilder \
    && useradd --uid 10001 --gid 10001 --create-home zdisbuilder
WORKDIR /build
USER 10001:10001
