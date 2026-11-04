# syntax=docker/dockerfile:1
#
# Birddog in a container.
#
#   docker build -t birddog .
#   docker run --rm -p 127.0.0.1:4747:4747 birddog --demo
#
# Stages:  test     runs the test suite (CI builds this with --target test)
#          package  `npm pack`, so the image gets exactly the files npm would publish
#          runtime  the small image you run (default)

ARG NODE_IMAGE=node:22.23.4-alpine3.24

# ---- test: the full repo, with git for the local-git tests ----------------------
FROM ${NODE_IMAGE} AS test
RUN apk add --no-cache git
WORKDIR /src
COPY . .
RUN npm test

# ---- package: only what the npm "files" list ships --------------------------------
FROM ${NODE_IMAGE} AS package
WORKDIR /src
COPY . .
RUN npm pack --silent --pack-destination /tmp >/dev/null \
 && mkdir /out && tar -xzf /tmp/bird-dog-*.tgz -C /out

# ---- runtime -----------------------------------------------------------------------
FROM ${NODE_IMAGE} AS runtime
# git for the local-git source; tini so Ctrl+C and `docker stop` shut down cleanly.
# Mounted repos belong to your host user, not to the container's, so tell git not to refuse them.
RUN apk add --no-cache git tini \
 && git config --system --add safe.directory '*' \
 && mkdir -p /data /repos && chown node:node /data

COPY --from=package /out/package /app

# BIRDDOG_CONTAINER=1 is the explicit "I am in Docker" switch (nothing is auto-detected):
#   - listen on BIRDDOG_HOST=0.0.0.0 inside the container (publish to 127.0.0.1 on the host!)
#   - secrets only from environment variables / Docker secrets, never written to disk
ENV NODE_ENV=production \
    BIRDDOG_CONTAINER=1 \
    BIRDDOG_HOST=0.0.0.0 \
    BIRDDOG_HOME=/data \
    BIRDDOG_SECRETS=env

USER node
# The working folder is where first-run setup looks for repos: mount yours here, read-only.
WORKDIR /repos
VOLUME ["/data"]
EXPOSE 4747

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:4747/api/health').then((r) => process.exit(r.ok ? 0 : 1), () => process.exit(1))"]

ENTRYPOINT ["/sbin/tini", "--", "node", "/app/bin/birddog.mjs"]
CMD []

LABEL org.opencontainers.image.title="Birddog" \
      org.opencontainers.image.description="A local-first \"what needs me next?\" inbox for developers" \
      org.opencontainers.image.source="https://github.com/marcsalot/birddog" \
      org.opencontainers.image.licenses="MIT"
