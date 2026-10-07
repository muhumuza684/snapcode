FROM node:20-slim

WORKDIR /home/node

# TIER 3: pre-install a small curated set of common packages at build time
# (same reasoning as the Python image — no per-run network access for
# arbitrary npm install). Installed as root, then handed to the "node" user.
RUN npm init -y && npm install --no-audit --no-fund axios lodash \
    && chown -R node:node /home/node

# TypeScript compiler, installed globally so `tsc` is on PATH. Reuses this
# same image for the "typescript" language entry — compilation happens
# fully offline (no network needed at run time), and this only adds the
# typescript package itself (tens of MB), not a whole new base image.
RUN npm install -g typescript

USER node

CMD ["node"]
