#!/usr/bin/env bash
# Redeploy the latest commit on the VPS. Run from /var/www/jetlag.
set -euo pipefail

git pull
npm ci
npm run build                 # rebuild front-end -> dist/

cd server && npm ci && cd ..  # refresh server deps if they changed

sudo systemctl restart jetlag-server
echo "Deployed. Nginx serves the new dist/ immediately."
