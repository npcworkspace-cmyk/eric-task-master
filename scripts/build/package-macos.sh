#!/bin/bash
set -euo pipefail

stage_root="${1:?stage root is required}"
output_dir="${2:?output directory is required}"
runtime_root="$(cd "${stage_root}/eric-task-master" && pwd)"
manifest="${runtime_root}/release-manifest.json"
version="$(node -e 'const fs=require("fs");process.stdout.write(JSON.parse(fs.readFileSync(process.argv[1],"utf8")).version)' "${manifest}")"
target="$(node -e 'const fs=require("fs");process.stdout.write(JSON.parse(fs.readFileSync(process.argv[1],"utf8")).target)' "${manifest}")"
case "${target}" in macos-arm64|macos-x64) ;; *) echo "Unexpected target: ${target}" >&2; exit 1 ;; esac

work="$(mktemp -d)"
trap 'rm -rf "${work}"' EXIT
payload="${work}/payload"
package_scripts="${work}/scripts"
install_root="${payload}/Library/Application Support/Eric Task Master"
mkdir -p "${install_root}" "${payload}/usr/local/bin" "${output_dir}" "${package_scripts}"
output_dir="$(cd "${output_dir}" && pwd)"
cp -R "${runtime_root}/." "${install_root}/"
ln -s "/Library/Application Support/Eric Task Master/bin/taskmaster" "${payload}/usr/local/bin/taskmaster"
cp "$(cd "$(dirname "$0")/../install/macos" && pwd)/preinstall" "${package_scripts}/preinstall"
chmod 0755 "${package_scripts}/preinstall"

asset="${output_dir}/eric-task-master-v${version}-${target}.pkg"
zip_asset="${output_dir}/eric-task-master-v${version}-${target}-portable.zip"
rm -f "${asset}" "${zip_asset}"
pkgbuild \
  --root "${payload}" \
  --identifier "com.npcworkspace.eric-task-master" \
  --version "${version}" \
  --scripts "${package_scripts}" \
  --install-location / \
  "${asset}"
test -x "${runtime_root}/bin/taskmaster" && test -x "${runtime_root}/runtime/node"
ditto -c -k --keepParent "${runtime_root}" "${zip_asset}"
test -f "${asset}" && test -f "${zip_asset}"
printf '{"ok":true,"target":"%s","signed":false,"assets":["%s","%s"]}\n' "${target}" "${asset}" "${zip_asset}"
