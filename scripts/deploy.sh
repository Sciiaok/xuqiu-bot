#!/bin/bash

# Deploy script for lead_engine_next to aws-foggy
# Usage: ./scripts/deploy.sh

set -e

# Configuration
SERVER="aws-foggy"
REMOTE_DIR="~/lead_engine_next"
APP_NAME="lead_engine_next"
TMP_FILE="/tmp/lead_engine_next.tar.gz"

# Colors for output
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
NC='\033[0m' # No Color

echo -e "${YELLOW}========================================${NC}"
echo -e "${YELLOW}  Deploying lead_engine_next to $SERVER${NC}"
echo -e "${YELLOW}========================================${NC}"

# Step 1: Create tarball (including node_modules for faster deploy)
echo -e "\n${GREEN}[1/6] Creating tarball...${NC}"
tar -czvf $TMP_FILE \
    --exclude='.next' \
    --exclude='.git' \
    --exclude='scripts/deploy.sh' \
    --exclude='scripts/migrate-sessions-to-v2.js' \
    .

# Step 2: Upload to server
echo -e "\n${GREEN}[2/6] Uploading to $SERVER...${NC}"
scp $TMP_FILE $SERVER:~/

# Step 3: Extract and setup on server
echo -e "\n${GREEN}[3/6] Extracting on server...${NC}"
ssh $SERVER "rm -rf $REMOTE_DIR && mkdir $REMOTE_DIR && tar -xzf ~/lead_engine_next.tar.gz -C $REMOTE_DIR && rm ~/lead_engine_next.tar.gz"

# Step 4: Rebuild native modules and build
echo -e "\n${GREEN}[4/6] Rebuilding native modules and building...${NC}"
ssh $SERVER "cd $REMOTE_DIR && npm rebuild && npm run build"

# Step 5: Restart PM2 main app
echo -e "\n${GREEN}[5/6] Restarting PM2 main app...${NC}"
ssh $SERVER "pm2 restart $APP_NAME || pm2 start $REMOTE_DIR/ecosystem.config.cjs --only lead-engine-next"

# Step 6: Restart PM2 cron service
echo -e "\n${GREEN}[6/6] Restarting PM2 cron service...${NC}"
ssh $SERVER "pm2 restart lead-sync-cron || pm2 start $REMOTE_DIR/ecosystem.config.cjs --only lead-sync-cron"

# Cleanup local temp file
rm -f $TMP_FILE

# Show status
echo -e "\n${GREEN}========================================${NC}"
echo -e "${GREEN}  Deployment complete!${NC}"
echo -e "${GREEN}========================================${NC}"

# Show PM2 status
echo -e "\n${YELLOW}PM2 Status:${NC}"
ssh $SERVER "pm2 status"

# Show URLs
echo -e "\n${YELLOW}URLs:${NC}"
echo "  - Dashboard: http://ec2-3-145-93-205.us-east-2.compute.amazonaws.com/dashboard"
echo "  - Login:     http://ec2-3-145-93-205.us-east-2.compute.amazonaws.com/login"
echo "  - Webhook:   http://ec2-3-145-93-205.us-east-2.compute.amazonaws.com/webhook"
echo "  - Health:    http://ec2-3-145-93-205.us-east-2.compute.amazonaws.com/api/health"
echo "  - Cron Sync: http://ec2-3-145-93-205.us-east-2.compute.amazonaws.com/api/cron/sync-leads"

echo -e "\n${YELLOW}Cron Logs:${NC}"
echo "  ssh $SERVER 'pm2 logs lead-sync-cron'"
