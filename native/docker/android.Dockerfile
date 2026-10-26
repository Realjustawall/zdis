FROM node:24-bookworm-slim AS node
FROM ghcr.io/cirruslabs/android-sdk:36
COPY --from=node /usr/local/bin/node /usr/local/bin/node
COPY --from=node /usr/local/lib/node_modules /usr/local/lib/node_modules
ARG ZDIS_BUILDER_UID=10001
ARG ZDIS_BUILDER_GID=10001
# AGP 8.13 uses Build Tools 35 by default even with compileSdk 36. Install
# both tool versions while building the image; runtime builders stay non-root.
RUN sdkmanager "build-tools;35.0.0" "build-tools;36.0.0" "platforms;android-36"
RUN ln -sf /usr/local/lib/node_modules/npm/bin/npm-cli.js /usr/local/bin/npm && ln -sf /usr/local/lib/node_modules/npm/bin/npx-cli.js /usr/local/bin/npx \
    && (getent group "$ZDIS_BUILDER_GID" || groupadd --gid "$ZDIS_BUILDER_GID" zdisbuilder) \
    && (getent passwd "$ZDIS_BUILDER_UID" || useradd --uid "$ZDIS_BUILDER_UID" --gid "$ZDIS_BUILDER_GID" --create-home --shell /bin/bash zdisbuilder)
WORKDIR /build
USER ${ZDIS_BUILDER_UID}:${ZDIS_BUILDER_GID}
