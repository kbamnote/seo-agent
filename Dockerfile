# Playwright's own image: Chromium and every system library it needs are already
# here. Installing them onto a bare node image is the usual way a hosted
# browser-automation deploy fails.
#
# This tag must match the playwright version in package.json exactly, which is
# why that dependency is pinned rather than a caret range: a fresh install that
# drifts to 1.50 would pair a newer library with this image's older Chromium,
# and Playwright refuses to run that combination.
FROM mcr.microsoft.com/playwright:v1.49.1-jammy

# That image ships Node 22, and this project stores everything in SQLite through
# `node:sqlite` — a built-in that only exists from Node 24. On 22 the container
# starts and dies instantly with "No such built-in module: node:sqlite".
# So: keep the image's Chromium, replace its Node.
RUN apt-get update && apt-get install -y --no-install-recommends curl ca-certificates gnupg && rm -rf /usr/local/bin/node /usr/local/bin/npm /usr/local/bin/npx /usr/local/lib/node_modules && curl -fsSL https://deb.nodesource.com/setup_24.x | bash - && apt-get install -y --no-install-recommends nodejs && apt-get clean && rm -rf /var/lib/apt/lists/* && node -e "const m=+process.versions.node.split('.')[0]; if (m < 24) { console.error('expected Node 24+, got '+process.versions.node); process.exit(1); } require('node:sqlite');" && npm --version && echo "node $(node --version), npm $(npm --version)"

WORKDIR /app
ENV NODE_ENV=production

# tsx runs the TypeScript directly, so devDependencies are needed at runtime.
# This project has no build step by design.
COPY package.json package-lock.json ./
RUN npm ci --include=dev

COPY . .

# Mount a Railway volume here. Everything that must survive a redeploy lives
# under it: the SQLite database, browser profiles, generated assets, reports.
# Without the volume the agent forgets every link it has ever built.
# No VOLUME instruction here: Railway rejects it and manages the mount itself.
# The directory still has to exist for the first boot, before anything is
# attached to it.
RUN mkdir -p /app/data

# Railway supplies PORT; the server binds whatever WEB_HOST says.
ENV WEB_HOST=0.0.0.0
EXPOSE 4317

# Run tsx through node directly. Going through npm here means every start
# depends on npm being healthy, and npm is the thing that broke.
CMD ["node", "node_modules/tsx/dist/cli.mjs", "src/cli.ts", "web"]
