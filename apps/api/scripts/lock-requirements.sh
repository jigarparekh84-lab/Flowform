#!/usr/bin/env bash
# Regenerate a pinned, hashed lock from its .in file.
#
#   ./scripts/lock-requirements.sh             # requirements.in  -> requirements.txt
#   ./scripts/lock-requirements.sh requirements-dev
#                                             # requirements-dev.in -> requirements-dev.txt
#
# Resolve inside a container so the resolver sees the same interpreter (and
# therefore the same platform-specific dependency set) as CI and the image.
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
name="${1:-requirements}"
python_image="${PYTHON_IMAGE:-python:3.12-slim}"
pip_tools_version="${PIP_TOOLS_VERSION:-7.4.1}"
tmp=".${name}.lock.tmp"

if [[ ! -f "${here}/${name}.in" ]]; then
  echo "missing ${here}/${name}.in" >&2
  exit 1
fi

docker run --rm -v "${here}:/w" -w /w "${python_image}" bash -lc "
  set -euo pipefail
  pip install --quiet 'pip-tools==${pip_tools_version}'
  # Compile to a scratch path: pip-compile reads an existing output file, and
  # the committed one is what we are replacing.
  pip-compile \
    --generate-hashes \
    --strip-extras \
    --no-emit-index-url \
    --no-emit-trusted-host \
    --no-header \
    --output-file /w/${tmp} \
    ${name}.in
"

# Replace pip-tools' recorded command line with the intent: where the pins come
# from, how to regenerate them, and what the hashes are protecting.
{
  echo '# apps/api dependency lock (CR-034) — generated, do not edit by hand.'
  echo '#'
  echo "#   source:    ${name}.in"
  echo "#   generated: pip-compile ${pip_tools_version} on ${python_image} (linux)"
  echo "#   regen:     apps/api/scripts/lock-requirements.sh ${name}"
  echo '#'
  echo '# pip installs this file in hash-checking mode: every package is pinned and'
  echo '# every allowed artifact carries a SHA-256. Any other version, or a tampered'
  echo '# artifact, fails the install instead of silently landing in production.'
  if [[ "${name}" == "requirements" ]]; then
    echo '#'
    echo '# The engine (apps/engine) is installed separately with --no-deps: a local'
    echo '# editable path cannot be represented in a hashed lock.'
  fi
  cat "${here}/${tmp}"
} > "${here}/${name}.txt"

rm -f "${here}/${tmp}"
echo "wrote ${here}/${name}.txt"
