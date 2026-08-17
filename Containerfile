FROM docker.io/library/node:26-bookworm-slim AS build

WORKDIR /build
COPY package.json package-lock.json ./
RUN npm ci
COPY issue-pilot.config.ts tsconfig.json ./
COPY drizzle ./drizzle
COPY src ./src
RUN npm run build \
    && npm prune --omit=dev \
    && find src/web -mindepth 1 -maxdepth 1 ! -name dist -exec rm -rf '{}' +

FROM docker.io/library/maven:3.9-eclipse-temurin-8 AS maven

FROM docker.io/library/node:26-bookworm-slim

ARG ALIYUN_CLI_VERSION=3.4.11
RUN apt-get update \
    && apt-get install --yes --no-install-recommends ca-certificates curl git openssh-client ripgrep \
    && architecture="$(dpkg --print-architecture)" \
    && case "$architecture" in \
         amd64) checksum=a7e3df497db14c10d4d7587795e9fa7849b0c51dfce02908b9de5a41fe717d5c ;; \
         arm64) checksum=b0b6f6f7545f9472b697fc27915c8956e5a3320a6160729dcc5b4eff21435ae8 ;; \
         *) exit 1 ;; \
       esac \
    && curl --fail --location --silent --show-error "https://github.com/aliyun/aliyun-cli/releases/download/v${ALIYUN_CLI_VERSION}/aliyun-cli-linux-${ALIYUN_CLI_VERSION}-${architecture}.tgz" --output /tmp/aliyun.tgz \
    && echo "$checksum  /tmp/aliyun.tgz" | sha256sum --check - \
    && tar --extract --gzip --file /tmp/aliyun.tgz --directory /tmp \
    && install -m 0555 /tmp/aliyun /usr/local/bin/aliyun \
    && rm -rf /tmp/aliyun /tmp/aliyun.tgz /var/lib/apt/lists/*
COPY --from=maven /opt/java/openjdk /opt/java/openjdk
COPY --from=maven /usr/share/maven /usr/share/maven
COPY --from=build /build /opt/issue-pilot
RUN ln -s /usr/share/maven/bin/mvn /usr/local/bin/mvn \
    && ln -s /opt/issue-pilot/node_modules/.bin/pi /usr/local/bin/pi

WORKDIR /opt/issue-pilot
ENV NODE_ENV=production \
    HOME=/home/node \
    JAVA_HOME=/opt/java/openjdk \
    MAVEN_HOME=/usr/share/maven \
    PATH=/opt/java/openjdk/bin:/usr/share/maven/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
USER node
EXPOSE 3000
CMD ["node", "--experimental-strip-types", "src/http/production.ts"]
