FROM ubuntu:24.04

ENV DEBIAN_FRONTEND=noninteractive
ARG UBUNTU_MIRROR=http://mirrors.ustc.edu.cn/ubuntu-ports
RUN sed -i "s|http://ports.ubuntu.com/ubuntu-ports|${UBUNTU_MIRROR}|g" /etc/apt/sources.list.d/ubuntu.sources \
  && apt-get update && apt-get install -y --no-install-recommends \
    xvfb x11vnc openbox xterm xauth fonts-dejavu-core \
  && rm -rf /var/lib/apt/lists/*

COPY start.sh /usr/local/bin/start-desktop
RUN chmod +x /usr/local/bin/start-desktop

CMD ["/usr/local/bin/start-desktop"]
