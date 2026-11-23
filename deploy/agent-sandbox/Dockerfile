# Build the standard agent-computer image at the same source commit, then
# use that image as the base for the isolated Flash lifecycle pilot.
ARG COMPUTER_IMAGE=openbot-computer-flash-base:local
FROM ${COMPUTER_IMAGE}

USER root
RUN apt-get update \
  && apt-get install -y --no-install-recommends python3 \
  && rm -rf /var/lib/apt/lists/* \
  && groupadd --gid 10001 openbot-work \
  && useradd --uid 10001 --gid 10001 --home-dir /workspace openbot-work \
  && chown 10001:10001 /workspace \
  && chmod 0700 /workspace
COPY --chmod=0755 lease_watchdog.py /usr/local/bin/openbot-lease

# Flash supplies envd. Never boot the base image's unguarded worker.
HEALTHCHECK NONE
CMD ["sleep", "infinity"]
