FROM docker.io/library/alpine:3.22.1@sha256:4bcff63911fcb4448bd4fdacec207030997caf25e9bea4045fa6c8c44de311d1

ARG TARGETARCH
ARG ALIYUN_CLI_VERSION=3.4.11

RUN set -eux; \
    apk add --no-cache ca-certificates jq; \
    apk add --no-cache --virtual .build-deps binutils; \
    case "$TARGETARCH" in \
      amd64) checksum="a7e3df497db14c10d4d7587795e9fa7849b0c51dfce02908b9de5a41fe717d5c" ;; \
      arm64) checksum="b0b6f6f7545f9472b697fc27915c8956e5a3320a6160729dcc5b4eff21435ae8" ;; \
      *) printf 'Unsupported architecture: %s\n' "$TARGETARCH" >&2; exit 1 ;; \
    esac; \
    archive="/tmp/aliyun-cli.tgz"; \
    wget -q "https://aliyuncli.alicdn.com/aliyun-cli-linux-${ALIYUN_CLI_VERSION}-${TARGETARCH}.tgz" -O "$archive"; \
    printf '%s  %s\n' "$checksum" "$archive" | sha256sum -c -; \
    tar -xzf "$archive" -C /tmp; \
    install -m 0555 /tmp/aliyun /usr/local/bin/aliyun; \
    strip /usr/local/bin/aliyun; \
    rm -f "$archive" /tmp/aliyun; \
    apk del .build-deps; \
    addgroup -S -g 65532 aliyun; \
    adduser -S -D -H -u 65532 -G aliyun aliyun; \
    install -d -m 0700 -o 65532 -g 65532 /home/aliyun /home/aliyun/.aliyun

LABEL org.opencontainers.image.title="Issue Pilot Aliyun CLI" \
      org.opencontainers.image.description="Pinned Alibaba Cloud CLI runtime for Issue Pilot capabilities" \
      org.opencontainers.image.source="https://github.com/idoly/issue-pilot" \
      org.opencontainers.image.version="${ALIYUN_CLI_VERSION}"

ENV HOME=/home/aliyun
USER 65532:65532
ENTRYPOINT ["/usr/local/bin/aliyun"]
CMD ["version"]
