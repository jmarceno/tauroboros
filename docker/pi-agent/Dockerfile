# Alpine-based Pi Agent Container
# Uses Alpine Linux with Bun and Pi pre-installed

FROM docker.io/alpine:3.19

# Install dependencies
RUN apk add --no-cache \
    git \
    openssh-client \
    ca-certificates \
    nodejs \
    npm \
    curl \
    bash

# Install Bun
RUN curl -fsSL https://bun.sh/install | bash && \
    mv /root/.bun/bin/bun /usr/local/bin/bun && \
    ln -s /usr/local/bin/bun /usr/local/bin/bunx

# Install pi globally
RUN npm install -g @mariozechner/pi-coding-agent

# Set up root home directory
ENV HOME=/root
RUN mkdir -p /root

# Create .pi directory for pi configuration
RUN mkdir -p /root/.pi

# Ensure /tmp exists and is writable
RUN mkdir -p /tmp && chmod 1777 /tmp

# Create workspace directory
RUN mkdir -p /workspace

# Default working directory (overridden at runtime)
WORKDIR /workspace

# Entry point runs pi in RPC mode
ENTRYPOINT ["pi", "--mode", "rpc", "--no-extensions"]
