#!/bin/bash

# Usage: ./scripts/deploy.sh

set -e

# Configuration
SERVER="aws-leadengine"
REMOTE_DIR="~/lead_engine_next"
APP_NAME="lead-engine-next"
TMP_FILE="/tmp/lead_engine_next.tar.gz"
TOTAL_STEPS=10

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

# Step 4: Stop all PM2 processes before build
echo -e "\n${GREEN}[4/${TOTAL_STEPS}] Stopping PM2 processes...${NC}"
ssh $SERVER "pm2 stop all 2>/dev/null || true"

# Step 5: Install dependencies and build
echo -e "\n${GREEN}[5/${TOTAL_STEPS}] Installing dependencies and building...${NC}"
ssh $SERVER "cd $REMOTE_DIR && mkdir -p logs && npm install --legacy-peer-deps && npm run build"

# Step 6: Restart PM2 main app
echo -e "\n${GREEN}[6/${TOTAL_STEPS}] Restarting PM2 main app...${NC}"
ssh $SERVER "pm2 restart $APP_NAME || pm2 start $REMOTE_DIR/ecosystem.config.cjs --only lead-engine-next"

# Step 7: Restart PM2 lead-sync cron service
echo -e "\n${GREEN}[7/${TOTAL_STEPS}] Restarting PM2 lead-sync cron...${NC}"
ssh $SERVER "pm2 restart lead-sync-cron || pm2 start $REMOTE_DIR/ecosystem.config.cjs --only lead-sync-cron"

# Step 8: Restart PM2 queue-cron service
echo -e "\n${GREEN}[8/${TOTAL_STEPS}] Restarting PM2 queue cron...${NC}"
ssh $SERVER "pm2 restart queue-cron || pm2 start $REMOTE_DIR/ecosystem.config.cjs --only queue-cron"

# Step 9: Restart PM2 report-cron service
echo -e "\n${GREEN}[9/${TOTAL_STEPS}] Restarting PM2 report cron...${NC}"
ssh $SERVER "pm2 restart report-cron || pm2 start $REMOTE_DIR/ecosystem.config.cjs --only report-cron"

# Step 10: Restart PM2 orchestrator-recovery service
echo -e "\n${GREEN}[10/${TOTAL_STEPS}] Restarting PM2 orchestrator recovery cron...${NC}"
ssh $SERVER "pm2 restart orchestrator-recovery || pm2 start $REMOTE_DIR/ecosystem.config.cjs --only orchestrator-recovery"

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
echo "  ssh $SERVER 'pm2 logs orchestrator-recovery'"
