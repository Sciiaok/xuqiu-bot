#!/bin/bash
# Usage: ./scripts/deploy.sh <server>
#   e.g. ./scripts/deploy.sh aws-online
set -e



## setup instructions for a fresh server (Ubuntu 22.04):
# sudo apt update
# sudo apt install -y curl git build-essential tar
# curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
# sudo apt install -y nodejs
# sudo npm install -g pm2
# sudo apt install -y redis-server
# sudo systemctl enable redis-server
# sudo systemctl start redis-server

# Configuration
SERVER="${1:?Usage: $0 <server>   (e.g. aws-online)}"
REMOTE_DIR="~/lead_engine_next"
APP_NAME="lead-engine-next"
TMP_FILE="/tmp/lead_engine_next.tar.gz"
TOTAL_STEPS=6

# Colors for output
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
NC='\033[0m' # No Color

echo -e "${YELLOW}========================================${NC}"
echo -e "${YELLOW}  Deploying lead_engine_next to $SERVER${NC}"
echo -e "${YELLOW}========================================${NC}"

# Step 1: Create tarball (excluding node_modules - will npm install on server)
echo -e "\n${GREEN}[1/${TOTAL_STEPS}] Creating tarball...${NC}"
tar -czvf $TMP_FILE \
    --no-xattrs \
    --exclude='.next' \
    --exclude='.git' \
    --exclude='node_modules' \
    --exclude='scripts/deploy.sh' \
    --exclude='scripts/migrate-sessions-to-v2.js' \
    .

# Step 2: Upload to server
echo -e "\n${GREEN}[2/${TOTAL_STEPS}] Uploading to $SERVER...${NC}"
scp $TMP_FILE $SERVER:~/

# Step 3: Extract and setup on server
echo -e "\n${GREEN}[3/${TOTAL_STEPS}] Extracting on server...${NC}"
ssh $SERVER "rm -rf $REMOTE_DIR && mkdir $REMOTE_DIR && tar -xzf ~/lead_engine_next.tar.gz -C $REMOTE_DIR && rm ~/lead_engine_next.tar.gz"

# Step 4: Stop main app before build (free memory for `next build` on small instances).
# Cron services can keep running — they don't fight for the build's memory budget.
echo -e "\n${GREEN}[4/${TOTAL_STEPS}] Stopping main app...${NC}"
ssh $SERVER "pm2 stop $APP_NAME 2>/dev/null || true"

# Step 5: Install dependencies and build
echo -e "\n${GREEN}[5/${TOTAL_STEPS}] Installing dependencies and building...${NC}"
ssh $SERVER "cd $REMOTE_DIR && mkdir -p logs && npm install --legacy-peer-deps && npm run build"

# Step 6: Start / reload all apps defined in ecosystem.config.cjs.
# `startOrReload` = "if running, reload; else start". `--update-env` forces PM2
# to re-read env vars from the config file (plain `pm2 restart` uses cached
# in-memory config and silently ignores config changes). `pm2 save` persists
# the process list so `pm2 resurrect` works after a server reboot.
echo -e "\n${GREEN}[6/${TOTAL_STEPS}] Starting / reloading all PM2 apps...${NC}"
ssh $SERVER "cd $REMOTE_DIR && pm2 startOrReload ecosystem.config.cjs --update-env && pm2 save"

# Cleanup local temp file
rm -f $TMP_FILE

# Show status
echo -e "\n${GREEN}========================================${NC}"
echo -e "${GREEN}  Deployment complete!${NC}"
echo -e "${GREEN}========================================${NC}"

# Show PM2 status
echo -e "\n${YELLOW}PM2 Status:${NC}"
ssh $SERVER "pm2 status"

echo -e "\n${YELLOW}Logs:${NC}"
echo "  ssh $SERVER 'pm2 logs lead-engine-next'"
echo "  ssh $SERVER 'pm2 logs lead-sync-cron'"
echo "  ssh $SERVER 'pm2 logs queue-cron'"
echo "  ssh $SERVER 'pm2 logs report-cron'"