# Dev image used by the install / server / web services in compose.yaml.
#
# Stays deliberately minimal: a Node 22 runtime + bash + the postgres client
# (used by the server entrypoint to wait on the db). Dependencies are
# installed at runtime by the one-shot `install` service against the
# bind-mounted source tree, so this image rarely needs to be rebuilt.
FROM node:22.20.0-alpine

RUN apk add --no-cache bash postgresql-client

WORKDIR /app

# Empty CMD on purpose — each compose service overrides with its own
# entrypoint script under /app/docker/.
CMD ["bash"]
