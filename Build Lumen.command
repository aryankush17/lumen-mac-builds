#!/bin/bash
set -euo pipefail
cd "$(dirname "$0")"
if [[ "$(uname -s)" != "Darwin" ]]; then
  echo "This build must run on a Mac. It cannot create a Mac installer on Windows."
  exit 1
fi
if ! command -v python3 >/dev/null; then
  echo "Install Python 3.11 or newer from python.org, then try again."
  exit 1
fi
python3 mac_build.py
echo "Build finished. See the Output folder and READ-ME-FIRST.txt."
read -r -p "Press Return to close."
