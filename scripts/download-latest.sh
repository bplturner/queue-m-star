#!/bin/bash
# Downloads the latest M-Star CFD nightly build, extracts it,
# flattens the nested directory, and copies the license file.
set -e

# Credentials
USERNAME="mstartrial"
PASSWORD="726fbb5"

# Where M-Star versions live
INSTALL_DIR="${MSTAR_INSTALL_DIR:-/opt/mstar}"
cd "$INSTALL_DIR" || { echo "Cannot cd into $INSTALL_DIR"; exit 1; }

# Fetch the JSON metadata
echo "[DOWNLOAD] Fetching latest version info..."
JSON=$(curl -s -u "$USERNAME:$PASSWORD" https://download.mstarcfd.com/api/latest.json)

# Extract the nightly version (e.g. "4.4.9")
VERSION=$(echo "$JSON" | jq -r '.nightly.version')
if [ -z "$VERSION" ] || [ "$VERSION" = "null" ]; then
  echo "[ERROR] Failed to retrieve version from API."
  exit 1
fi

# Check if already installed
DIR="mstarcfd-$VERSION"
if [ -d "$DIR" ] && [ -f "$DIR/bin/mstar-cfd-mgpu" ]; then
  echo "[DOWNLOAD] Version $VERSION is already installed at $INSTALL_DIR/$DIR"
  echo "[DOWNLOAD] Skipping download."
  exit 0
fi

# Create the version directory
mkdir -p "$DIR"

# Extract the download link for Ubuntu 22
DOWNLOAD_LINK=$(echo "$JSON" | jq -r '.nightly.files[]
  | select(.platform == "Ubuntu 22")
  | .link')

if [ -z "$DOWNLOAD_LINK" ] || [ "$DOWNLOAD_LINK" = "null" ]; then
  echo "[ERROR] Failed to retrieve the download link for Ubuntu 22."
  exit 1
fi

echo "[DOWNLOAD] Downloading M-Star CFD v$VERSION..."
echo "[DOWNLOAD] URL: $DOWNLOAD_LINK"
curl -L -u "$USERNAME:$PASSWORD" "$DOWNLOAD_LINK" | tar -zxf - -C "$DIR"

# Flatten nested directory (tarball extracts into mstar-ubuntu/ or similar)
# Find the single subdirectory and move its contents up
NESTED_DIR=$(find "$DIR" -mindepth 1 -maxdepth 1 -type d | head -1)
if [ -n "$NESTED_DIR" ] && [ -d "$NESTED_DIR/bin" ]; then
  echo "[DOWNLOAD] Flattening nested directory: $(basename "$NESTED_DIR")"
  # Move all contents up one level
  mv "$NESTED_DIR"/* "$DIR/" 2>/dev/null || true
  mv "$NESTED_DIR"/.* "$DIR/" 2>/dev/null || true
  rmdir "$NESTED_DIR" 2>/dev/null || true
fi

# Verify extraction
if [ ! -f "$DIR/bin/mstar-cfd-mgpu" ]; then
  echo "[ERROR] Extraction failed — mstar-cfd-mgpu not found in $DIR/bin/"
  exit 1
fi

# Copy license file from the current latest version
# Find an existing .lic file in any installed version's bin/
LICENSE_SRC=$(find "$INSTALL_DIR"/mstarcfd-*/bin -name "*.lic" -type f 2>/dev/null | head -1)
if [ -n "$LICENSE_SRC" ]; then
  LICENSE_NAME=$(basename "$LICENSE_SRC")
  if [ ! -f "$DIR/bin/$LICENSE_NAME" ]; then
    cp "$LICENSE_SRC" "$DIR/bin/$LICENSE_NAME"
    echo "[DOWNLOAD] Copied license file: $LICENSE_NAME → $DIR/bin/"
  else
    echo "[DOWNLOAD] License file already exists in $DIR/bin/"
  fi
else
  echo "[WARNING] No license file found in any existing installation"
fi

echo "[DOWNLOAD] ✓ M-Star CFD v$VERSION installed at $INSTALL_DIR/$DIR"
echo "$VERSION"
