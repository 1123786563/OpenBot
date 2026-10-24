FROM ubuntu:24.04

ENV DEBIAN_FRONTEND=noninteractive
ARG UBUNTU_MIRROR=http://mirrors.ustc.edu.cn/ubuntu
RUN sed -i "s|http://archive.ubuntu.com/ubuntu|${UBUNTU_MIRROR}|g; s|http://security.ubuntu.com/ubuntu|${UBUNTU_MIRROR}|g" /etc/apt/sources.list.d/ubuntu.sources \
  && apt-get update && apt-get install -y --no-install-recommends \
    ca-certificates curl dbus-x11 at-spi2-core libatspi2.0-0 libxi6 \
    xvfb x11vnc openbox xterm xauth fonts-dejavu-core \
  && rm -rf /var/lib/apt/lists/*
RUN apt-get update && apt-get install -y --no-install-recommends libxkbcommon0 \
  && rm -rf /var/lib/apt/lists/*

ARG CUA_DRIVER_URL=https://github.com/trycua/cua/releases/download/cua-driver-rs-v0.38.0/cua-driver-rs-0.38.0-linux-x86_64-binary.tar.gz
ARG CUA_DRIVER_SHA256=31ab9709dd91ce73677e49b9f3e75c6f0d3e4d9625c286c9e58262bfbea698dd
RUN curl -fL --retry 3 \
    "${CUA_DRIVER_URL}" \
    -o /tmp/cua-driver.tar.gz \
  && echo "${CUA_DRIVER_SHA256}  /tmp/cua-driver.tar.gz" | sha256sum -c - \
  && tar -tzf /tmp/cua-driver.tar.gz \
  && mkdir -p /tmp/cua-driver \
  && tar -xzf /tmp/cua-driver.tar.gz -C /tmp/cua-driver \
  && find /tmp/cua-driver -type f -name cua-driver -exec cp {} /usr/local/bin/cua-driver \; \
  && test -x /usr/local/bin/cua-driver \
  && rm -rf /tmp/cua-driver /tmp/cua-driver.tar.gz

COPY start.sh /usr/local/bin/start-desktop
RUN chmod +x /usr/local/bin/start-desktop

CMD ["/usr/local/bin/start-desktop"]
