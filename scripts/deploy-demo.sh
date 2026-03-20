#!/bin/bash

# Deploy DEMO mode to scm_aliyun
# Usage: ./scripts/deploy-demo.sh

set -e

# Configuration
SERVER="scm_aliyun"
REMOTE_DIR="~/lead_engine_demo"
APP_NAME="lead-engine-demo"
TMP_FILE="/tmp/lead_engine_demo.tar.gz"
ENV_FILE=".env.demo"

# Colors
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
NC='\033[0m'

# Pre-flight check
if [ ! -f "$ENV_FILE" ]; then
  echo -e "${RED}Error: $ENV_FILE not found${NC}"
  exit 1
fi

echo -e "${YELLOW}========================================${NC}"
echo -e "${YELLOW}  Deploying DEMO to $SERVER${NC}"
echo -e "${YELLOW}========================================${NC}"

# Step 1: Create tarball
echo -e "\n${GREEN}[1/6] Creating tarball...${NC}"
tar -czf $TMP_FILE \
    --exclude='.next' \
    --exclude='.git' \
    --exclude='node_modules' \
    --exclude='.env.local' \
    --exclude='.env.demo' \
    --exclude='scripts/deploy.sh' \
    --exclude='scripts/deploy-demo.sh' \
    .

# Step 2: Upload tarball + env file
echo -e "\n${GREEN}[2/6] Uploading to $SERVER...${NC}"
scp $TMP_FILE $SERVER:~/
scp $ENV_FILE $SERVER:~/lead_engine_demo.env

# Step 3: Extract and setup
echo -e "\n${GREEN}[3/6] Extracting on server...${NC}"
ssh $SERVER "mkdir -p $REMOTE_DIR && rm -rf $REMOTE_DIR/* && tar -xzf ~/lead_engine_demo.tar.gz -C $REMOTE_DIR && mv ~/lead_engine_demo.env $REMOTE_DIR/.env.local && rm ~/lead_engine_demo.tar.gz"

# Step 4: Install dependencies and build
echo -e "\n${GREEN}[4/6] Installing dependencies and building...${NC}"
ssh $SERVER "cd $REMOTE_DIR && npm install --legacy-peer-deps && npm run build"

# Step 5: Start/restart PM2 (main app only, no cron/queue)
echo -e "\n${GREEN}[5/6] Starting PM2 app (demo mode, no cron)...${NC}"
ssh $SERVER "pm2 delete $APP_NAME 2>/dev/null; cd $REMOTE_DIR && pm2 start npm --name $APP_NAME -- start"

# Step 6: Save PM2 config
echo -e "\n${GREEN}[6/6] Saving PM2 config...${NC}"
ssh $SERVER "pm2 save"

# Cleanup
rm -f $TMP_FILE

# Status
echo -e "\n${GREEN}========================================${NC}"
echo -e "${GREEN}  Demo deployment complete!${NC}"
echo -e "${GREEN}========================================${NC}"

ssh $SERVER "pm2 status"

echo -e "\n${YELLOW}Access:${NC}"
echo "  ssh $SERVER 'pm2 logs $APP_NAME'"
