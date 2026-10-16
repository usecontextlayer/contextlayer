FROM node:24-trixie-slim AS daemon
RUN npm install --global pnpm@11.22.0
WORKDIR /pi
RUN pnpm add --ignore-scripts --save-exact @earendil-works/pi-env@1.3.0

FROM node:24-trixie-slim
COPY --from=daemon /pi/node_modules/@earendil-works/pi-env/bin/pi-env-linux-x64/pi-env /usr/local/bin/pi-env
RUN mkdir /workspace
WORKDIR /workspace
CMD ["sleep", "infinity"]
