# Debian-based Pi Agent Container
# Uses Debian trixie-slim with Bun and Pi pre-installed

FROM debian:trixie-slim

ENV DEBIAN_FRONTEND=noninteractive
ENV PI_OFFLINE=1
ENV HOME=/root

RUN apt-get update && apt-get install -y \
    git \
    openssh-client \
    curl \
    bash \
    unzip \
    ca-certificates \
    gnupg \
    chromium \
    nodejs \
    npm \
    libglib2.0-0 \
    libnss3 \
    libatk1.0-0 \
    libatk-bridge2.0-0 \
    libcups2t64 \
    libdrm2 \
    libxkbcommon0 \
    libxcomposite1 \
    libxdamage1 \
    libxfixes3 \
    libxrandr2 \
    libgbm1 \
    libpango-1.0-0 \
    libcairo2 \
    libasound2t64 \
    && rm -rf /var/lib/apt/lists/* \
    && apt-get clean

RUN curl -fsSL https://bun.sh/install | bash && \
    mv /root/.bun/bin/bun /usr/local/bin/bun && \
    ln -s /usr/local/bin/bun /usr/local/bin/bunx

RUN npm install -g @mariozechner/pi-coding-agent

RUN mkdir -p /root
RUN mkdir -p /root/.pi
RUN mkdir -p /tmp && chmod 1777 /tmp
RUN mkdir -p /workspace

WORKDIR /workspace

ENTRYPOINT ["pi", "--mode", "rpc"]