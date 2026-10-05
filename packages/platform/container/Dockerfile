FROM debian:trixie-slim

RUN apt-get update \
    && apt-get install -y --no-install-recommends bash ca-certificates git \
    && rm -rf /var/lib/apt/lists/*

CMD ["sleep", "infinity"]
