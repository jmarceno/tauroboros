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
    python3 \
    python3-pip \
    python3-venv \
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

# Install docker SDK for Python programmatic access
RUN pip3 install --break-system-packages docker

# Download standalone docker-compose binary (Python 3.13 compatible)
RUN curl -SL https://github.com/docker/compose/releases/download/v2.32.4/docker-compose-linux-x86_64 -o /usr/local/bin/docker-compose && \
    chmod +x /usr/local/bin/docker-compose

# Install uv (Python package manager)
RUN curl -fsSL https://astral.sh/uv/install.sh | bash && \
    mv /root/.local/bin/uv /usr/local/bin/uv && \
    mv /root/.local/bin/uvx /usr/local/bin/uvx

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