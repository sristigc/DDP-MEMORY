FROM node:22-slim

# Bump these two together; check CHANGELOG of @agentmemory/agentmemory first.
ARG AGENTMEMORY_VERSION=0.9.29
# agentmemory 0.9.x expects iii-engine 0.11.2.
ARG III_VERSION=0.11.2

ENV NODE_ENV=production
ENV HOME=/app
ENV PATH="/app/.local/bin:${PATH}"

WORKDIR /app

RUN apt-get update \
  && apt-get install -y --no-install-recommends \
    ca-certificates \
    curl \
    tar \
    bash \
    sed \
    grep \
    socat \
  && rm -rf /var/lib/apt/lists/*

RUN npm install -g "@agentmemory/agentmemory@${AGENTMEMORY_VERSION}"

RUN mkdir -p /app/.local/bin \
  && curl -fsSL "https://github.com/iii-hq/iii/releases/download/iii/v${III_VERSION}/iii-x86_64-unknown-linux-gnu.tar.gz" \
  | tar -xz -C /app/.local/bin \
  && chmod +x /app/.local/bin/iii

RUN mkdir -p /data /app

COPY start.sh /app/start.sh
# Strip CRLF in case the file was checked out on Windows without .gitattributes.
RUN sed -i 's/\r$//' /app/start.sh && chmod +x /app/start.sh

# 8080 = public REST API, 3112 = streams, 8083 = viewer proxy, 49134 = iii engine
EXPOSE 8080
EXPOSE 3112
EXPOSE 8083
EXPOSE 49134

CMD ["/app/start.sh"]
