# Offline CloudCLI image: the release image plus everything it would download at
# start, for machines that cannot reach the internet to install mise runtimes.
#
#   docker build -f docker/offline/Dockerfile \
#     --build-arg BASE_IMAGE=ghcr.io/nmng108/cloudcli:1.39.0 \
#     -t ghcr.io/nmng108/cloudcli:1.39.0-offline docker/
#
# It adds one layer to the normal image, so there is nothing here to keep in step
# with docker/standard/Dockerfile. The language list is docker/mise.toml, already
# in the base image at /etc/mise/config.toml with every version pinned exactly.
#
# The runtimes go into /opt/mise-baked, not the /mise volume. A named volume copies
# the image's content only when it is created, so an existing volume (from an older
# install) would hide runtimes added by a newer image. MISE_SYSTEM_DATA_DIR makes
# mise look in /opt/mise-baked as well; mise-sync.mjs then finds everything installed
# and starts without network. What users install themselves still goes to /mise,
# and its shims come first on PATH.
ARG BASE_IMAGE=ghcr.io/nmng108/cloudcli:latest
FROM ${BASE_IMAGE}

RUN mkdir -p /opt/mise-baked && chown agent:agent /opt/mise-baked
USER agent
RUN MISE_DATA_DIR=/opt/mise-baked MISE_CACHE_DIR=/tmp/mise-cache MISE_STATE_DIR=/tmp/mise-state \
      mise install && \
    rm -rf /tmp/mise-cache /tmp/mise-state
# `mise install` does not create the shims that put java, python, ... on PATH; they are
# made here, in the baked directory, because the shims of /mise start out empty.
RUN MISE_DATA_DIR=/opt/mise-baked mise reshim
USER root

# After /mise/shims (what users install themselves), so their versions win.
ENV MISE_SYSTEM_DATA_DIR=/opt/mise-baked \
    PATH="${PATH}:/opt/mise-baked/shims"
