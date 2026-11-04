# Playwright's own image: Chromium and every system library it needs are already
# here. Installing them onto a bare node image is the usual way a hosted
# browser-automation deploy fails.
#
# This tag must match the playwright version in package.json exactly, which is
# why that dependency is pinned rather than a caret range: a fresh install that
# drifts to 1.50 would pair a newer library with this image's older Chromium,
# and Playwright refuses to run that combination.
FROM mcr.microsoft.com/playwright:v1.49.1-jammy

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
RUN mkdir -p /app/data
VOLUME ["/app/data"]

# Railway supplies PORT; the server binds whatever WEB_HOST says.
ENV WEB_HOST=0.0.0.0
EXPOSE 4317

CMD ["npm", "run", "web"]
