#!/bin/bash
# push-all.sh — Push both public and private repos in one command
#
# Usage:
#   ./push-all.sh                    # Push both repos to their respective remotes
#   ./push-all.sh "commit message"   # Commit all changes in both repos, then push
#
# Repository layout:
#   queue-m-star (PUBLIC)  → github.com/bplturner/queue-m-star
#   python/ai_training/    → github.com/bplturner/queue-m-star-private (PRIVATE submodule)

set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
SUBMODULE_DIR="${SCRIPT_DIR}/python/ai_training"
COMMIT_MSG="$1"

GREEN='\033[0;32m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
NC='\033[0m'

echo ""
echo "======================================================"
echo "  Push All — Public + Private Repos"
echo "======================================================"
echo ""

# -------------------------------------------------------
# Step 1: Handle the private submodule (AI training)
# -------------------------------------------------------
echo -e "${YELLOW}[1/4] Private repo (AI Training)${NC}"

if [ ! -d "${SUBMODULE_DIR}/.git" ] && [ ! -f "${SUBMODULE_DIR}/.git" ]; then
    echo -e "${RED}      ✗ Submodule not initialized. Run: git submodule update --init${NC}"
    exit 1
fi

cd "${SUBMODULE_DIR}"

# Check for changes in the private repo
if [ -n "$(git status --porcelain)" ]; then
    if [ -n "${COMMIT_MSG}" ]; then
        echo "      Committing private changes..."
        git add -A
        git commit -m "${COMMIT_MSG}"
    else
        echo -e "${YELLOW}      ⚠ Private repo has uncommitted changes. Commit them first or pass a message:${NC}"
        echo "        ./push-all.sh \"your commit message\""
        git status --short
        exit 1
    fi
fi

echo "      Pushing to private remote..."
git push origin main 2>&1 | sed 's/^/      /'
echo -e "${GREEN}      ✓ Private repo pushed${NC}"

# -------------------------------------------------------
# Step 2: Update submodule reference in public repo
# -------------------------------------------------------
cd "${SCRIPT_DIR}"
echo ""
echo -e "${YELLOW}[2/4] Updating submodule reference${NC}"

# Stage the new submodule commit hash
git add python/ai_training

if [ -n "$(git diff --cached --name-only -- python/ai_training)" ]; then
    echo "      Submodule updated to: $(cd python/ai_training && git rev-parse --short HEAD)"
else
    echo "      Submodule already up to date"
fi

# -------------------------------------------------------
# Step 3: Commit public repo changes
# -------------------------------------------------------
echo ""
echo -e "${YELLOW}[3/4] Public repo (Queue M-Star)${NC}"

if [ -n "$(git status --porcelain)" ]; then
    if [ -n "${COMMIT_MSG}" ]; then
        echo "      Committing public changes..."
        git add -A
        git commit -m "${COMMIT_MSG}"
    else
        # Only auto-commit if the only change is the submodule pointer
        if [ "$(git diff --cached --name-only | wc -l)" -eq 1 ] && \
           [ "$(git diff --cached --name-only)" = "python/ai_training" ]; then
            git commit -m "Update AI training submodule"
        else
            echo -e "${YELLOW}      ⚠ Public repo has uncommitted changes. Pass a commit message:${NC}"
            echo "        ./push-all.sh \"your commit message\""
            git status --short
            exit 1
        fi
    fi
fi

# -------------------------------------------------------
# Step 4: Push public repo
# -------------------------------------------------------
echo ""
echo -e "${YELLOW}[4/4] Pushing public repo${NC}"

git push origin main 2>&1 | sed 's/^/      /'
echo -e "${GREEN}      ✓ Public repo pushed${NC}"

echo ""
echo "======================================================"
echo -e "  ${GREEN}✓ All repos pushed successfully!${NC}"
echo ""
echo "  Public:  https://github.com/bplturner/queue-m-star"
echo "  Private: https://github.com/bplturner/queue-m-star-private"
echo "======================================================"
