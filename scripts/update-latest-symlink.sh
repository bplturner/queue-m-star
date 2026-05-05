#!/bin/bash
# Finds the latest mstarcfd-X.Y.Z directory and creates wrapper scripts
# that source the environment and exec the real binary.
# Also creates a mstarcfd-latest symlink.
set -e

# Where M-Star versions live
TARGET_DIR="${MSTAR_INSTALL_DIR:-/opt/mstar}"

# All binaries to create wrappers for
TOOLS=(
  mstar
  mstar-cfd
  mstar-cfd-mgpu
  mstar-cfd-mgpu-d
  mstar-fill
  MStarPost
  mstar-util
  stats-lister
)

cd "$TARGET_DIR" || { echo "Cannot cd into $TARGET_DIR"; exit 1; }

# Grab the latest version folder (sort by version number)
dirs=(mstarcfd-*.*.*)
[ ${#dirs[@]} -gt 0 ] || { echo "No version dirs found"; exit 1; }
latest=$(printf "%s\n" "${dirs[@]}" | sort -V | tail -1)

# Absolute paths into the latest folder
ABS_ROOT="$TARGET_DIR/$latest"
MSTAR_SH="$ABS_ROOT/mstar.sh"
BIN_DIR="$ABS_ROOT/bin"

# Sanity checks
[ -r "$MSTAR_SH" ] || { echo "Missing $MSTAR_SH"; exit 1; }
[ -d "$BIN_DIR" ]  || { echo "Missing $BIN_DIR";  exit 1; }

echo "[SYMLINK] Using version: $latest"
echo "[SYMLINK]  Env script: $MSTAR_SH"
echo "[SYMLINK]      bin dir: $BIN_DIR"
echo

for tool in "${TOOLS[@]}"; do
  wrapper="${tool}-latest"
  cat > "$wrapper" <<EOF
#!/usr/bin/env bash
# AUTO-GENERATED — calls $tool from $latest

# Set up environment
source "$MSTAR_SH"

# Hand off to the real binary
exec "$BIN_DIR/$tool" "\$@"
EOF

  chmod +x "$wrapper"
  ln -sf "$TARGET_DIR/$wrapper" "/usr/local/bin/$wrapper"
  echo "[SYMLINK] Installed: /usr/local/bin/$wrapper → $TARGET_DIR/$wrapper"
done

# Create a symlink for the entire latest directory
ln -sf "$latest" "mstarcfd-latest"
echo "[SYMLINK] Created link: $TARGET_DIR/mstarcfd-latest → $TARGET_DIR/$latest"

echo
echo "[SYMLINK] ✓ All wrappers (${TOOLS[*]}-latest) are now in /usr/local/bin/"

# Extract version number from directory name
VERSION=$(echo "$latest" | sed 's/mstarcfd-//')
echo "$VERSION"
