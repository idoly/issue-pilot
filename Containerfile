FROM docker.io/library/node:26-bookworm-slim AS build

WORKDIR /build
COPY package.json package-lock.json ./
RUN npm ci
COPY issue-pilot.config.ts tsconfig.json requirements.txt ./
COPY drizzle ./drizzle
COPY src ./src
COPY scripts ./scripts
COPY examples ./examples
RUN npm run build \
    && npm prune --omit=dev \
    && find src/web -mindepth 1 -maxdepth 1 ! -name dist -exec rm -rf '{}' +

FROM docker.io/library/maven:3.9-eclipse-temurin-8 AS maven

FROM docker.io/library/debian:bookworm-slim AS git

ARG GIT_VERSION=2.53.0
RUN apt-get update \
    && apt-get install --yes --no-install-recommends build-essential ca-certificates curl libcurl4-openssl-dev libexpat1-dev libssl-dev zlib1g-dev \
    && curl --fail --location --silent --show-error "https://mirrors.edge.kernel.org/pub/software/scm/git/git-${GIT_VERSION}.tar.xz" --output /tmp/git.tar.xz \
    && tar --extract --xz --file /tmp/git.tar.xz --directory /tmp \
    && make -C "/tmp/git-${GIT_VERSION}" -j"$(nproc)" prefix=/opt/git NO_GETTEXT=YesPlease NO_TCLTK=YesPlease all \
    && make -C "/tmp/git-${GIT_VERSION}" prefix=/opt/git NO_GETTEXT=YesPlease NO_TCLTK=YesPlease install

FROM docker.io/library/node:26-bookworm-slim

RUN apt-get update \
    && apt-get install --yes --no-install-recommends ca-certificates curl libexpat1 openssh-client perl python3 python3-venv ripgrep \
    && rm -rf /var/lib/apt/lists/*
ARG ALIYUN_CLI_VERSION=3.4.11
RUN curl --fail --location --silent --show-error "https://aliyuncli.alicdn.com/aliyun-cli-linux-${ALIYUN_CLI_VERSION}-$(dpkg --print-architecture).tgz" --output /tmp/aliyun.tgz \
    && tar --extract --gzip --file /tmp/aliyun.tgz --directory /usr/local/bin aliyun \
    && chmod 0755 /usr/local/bin/aliyun \
    && test "$(aliyun version)" = "$ALIYUN_CLI_VERSION" \
    && rm -f /tmp/aliyun.tgz
COPY --from=maven /opt/java/openjdk /opt/java/openjdk
COPY --from=maven /usr/share/maven /usr/share/maven
COPY --from=git /opt/git /opt/git
COPY --from=build /build /opt/issue-pilot
RUN python3 -m venv /opt/issue-pilot/.venv \
    && /opt/issue-pilot/.venv/bin/python3 -m pip install --no-cache-dir -r /opt/issue-pilot/requirements.txt \
    && ln -s /usr/share/maven/bin/mvn /usr/local/bin/mvn \
    && ln -s /opt/issue-pilot/node_modules/.bin/pi /usr/local/bin/pi

WORKDIR /opt/issue-pilot
ENV NODE_ENV=production \
    HOME=/home/node \
    JAVA_HOME=/opt/java/openjdk \
    MAVEN_HOME=/usr/share/maven \
    PATH=/opt/issue-pilot/.venv/bin:/opt/git/bin:/opt/java/openjdk/bin:/usr/share/maven/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
USER node
EXPOSE 3000
CMD ["node", "--experimental-strip-types", "src/http/production.ts"]
