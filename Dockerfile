# Start from Node, add Chromium — not the other way round.
#
# This began on mcr.microsoft.com/playwright, which ships its own Node 22 and an
# npm compiled against it. The project needs Node 24 for `node:sqlite`, and
# installing 24 over the top left a mismatched npm on PATH, so every start died
# with "Class extends value undefined is not a constructor or null". Two rounds
# of patching that image did not settle it.
#
# A Node 24 base has a matching npm from the first layer, and Playwright can
# install its own browser. Nothing is mismatched, and the start command works
# whether it goes through npm or node.
FROM node:24-bookworm-slim

WORKDIR /app
ENV NODE_ENV=production

# tsx runs the TypeScript directly, so devDependencies are needed at runtime.
# This project has no build step by design.
COPY package.json package-lock.json ./
RUN npm ci --include=dev

# Chromium plus the system libraries it needs, installed by Playwright itself,
# so the browser always matches the pinned library version.
RUN npx playwright install --with-deps chromium \
 && rm -rf /var/lib/apt/lists/*

COPY . .

# Prove the toolchain and the real start path before shipping the image: a
# failure here is a build failure, not a crash loop in production.
RUN echo "node: $(node --version), npm: $(npm --version)" \
 && node -e "const m=+process.versions.node.split('.')[0]; if (m < 24) { console.error('expected Node 24+, got '+process.versions.node); process.exit(1); } require('node:sqlite');" \
 && node node_modules/tsx/dist/cli.mjs src/cli.ts --version \
 && echo "start command OK"

# Mount a Railway volume here. Everything that must survive a redeploy lives
# under it: the SQLite database, browser profiles, generated assets, reports.
# Without the volume the agent forgets every link it has ever built.
# No VOLUME instruction: Railway rejects it and manages the mount itself.
RUN mkdir -p /app/data

# Railway supplies PORT; the server binds whatever WEB_HOST says.
ENV WEB_HOST=0.0.0.0
EXPOSE 4317

CMD ["node", "node_modules/tsx/dist/cli.mjs", "src/cli.ts", "web"]
