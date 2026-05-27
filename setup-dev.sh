#!/bin/bash
# setup-dev.sh — One-time developer setup after cloning
#
# Run this after cloning the repository to:
#   1. Configure the pre-commit security hook
#   2. Initialize the AI training submodule (if you have access)
#
# Usage:  ./setup-dev.sh

set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
cd "${SCRIPT_DIR}"

GREEN='\033[0;32m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
NC='\033[0m'

echo ""
echo "======================================================"
echo "  M-Star Queue — Developer Setup"
echo "======================================================"
echo ""

# 1. Configure pre-commit hooks
echo -e "${YELLOW}[1/2] Configuring security hooks...${NC}"
git config core.hooksPath .githooks
chmod +x .githooks/pre-commit
echo -e "${GREEN}      ✓ Pre-commit hook active (blocks secrets + AI code leaks)${NC}"

# 2. Initialize submodule (AI training — private repo)
echo ""
echo -e "${YELLOW}[2/2] Initializing AI training submodule...${NC}"
if git submodule update --init python/ai_training 2>/dev/null; then
    echo -e "${GREEN}      ✓ AI training submodule initialized${NC}"
else
    echo -e "${YELLOW}      ⚠ Could not initialize AI training submodule${NC}"
    echo "      This is expected if you don't have access to the private repo."
    echo "      The public queue application works without it."
fi

echo ""
echo "======================================================"
echo -e "  ${GREEN}✓ Setup complete!${NC}"
echo ""
echo "  Security:  Pre-commit hook prevents secrets from going public"
echo "  Hooks dir: .githooks/pre-commit"
echo "  Push both: ./push-all.sh \"commit message\""
echo "======================================================"
