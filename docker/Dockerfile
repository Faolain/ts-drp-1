FROM node:22.14.0-bookworm-slim

ENV PNPM_HOME="/pnpm"
ENV PATH="$PNPM_HOME:$PATH"
RUN npm install -g typescript@5.7.3
RUN corepack enable && corepack prepare pnpm@10.24.0 --activate

WORKDIR /ts-drp
COPY . .

RUN pnpm i --prod
RUN chmod +x /ts-drp/docker/entrypoint.sh

ENTRYPOINT ["/bin/bash", "/ts-drp/docker/entrypoint.sh"]
