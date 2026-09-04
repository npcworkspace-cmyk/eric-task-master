#!/bin/bash
set -euo pipefail

stage_root="${1:?stage root is required}"
output_dir="${2:?output directory is required}"
runtime_root="$(cd "${stage_root}/eric-task-master" && pwd)"
manifest="${runtime_root}/release-manifest.json"
version="$(node -e 'const fs=require("fs");process.stdout.write(JSON.parse(fs.readFileSync(process.argv[1],"utf8")).version)' "${manifest}")"
target="$(node -e 'const fs=require("fs");process.stdout.write(JSON.parse(fs.readFileSync(process.argv[1],"utf8")).target)' "${manifest}")"
case "${target}" in
  linux-x64) deb_arch=amd64 ;;
  linux-arm64) deb_arch=arm64 ;;
  *) echo "Unexpected target: ${target}" >&2; exit 1 ;;
esac

mkdir -p "${output_dir}"
output_dir="$(cd "${output_dir}" && pwd)"
work="$(mktemp -d)"
trap 'rm -rf "${work}"' EXIT
deb_root="${work}/deb"
mkdir -p "${deb_root}/DEBIAN" "${deb_root}/opt/eric-task-master" "${deb_root}/usr/bin"
cp -a "${runtime_root}/." "${deb_root}/opt/eric-task-master/"
ln -s /opt/eric-task-master/bin/taskmaster "${deb_root}/usr/bin/taskmaster"
cp "$(cd "$(dirname "$0")/../install/linux" && pwd)/preinst" "${deb_root}/DEBIAN/preinst"
chmod 0755 "${deb_root}/DEBIAN/preinst"
installed_size="$(du -sk "${deb_root}/opt/eric-task-master" | cut -f1)"
cat > "${deb_root}/DEBIAN/control" <<EOF
Package: eric-task-master
Version: ${version}
Section: utils
Priority: optional
Architecture: ${deb_arch}
Installed-Size: ${installed_size}
Maintainer: NPC Workspace <npcworkspace-cmyk@users.noreply.github.com>
Depends: libc6 (>= 2.28), libstdc++6
Suggests: google-chrome-stable
Description: Local long-running browser task manager and CLI for trusted Agents
 Includes a private Node.js runtime and Playwright library. Google Chrome is
 discovered on the machine and is not included in this package.
EOF

deb_asset="${output_dir}/eric-task-master-v${version}-${target}.deb"
tar_asset="${output_dir}/eric-task-master-v${version}-${target}-portable.tar.gz"
zip_asset="${output_dir}/eric-task-master-v${version}-${target}-portable.zip"
rm -f "${deb_asset}" "${tar_asset}" "${zip_asset}"
dpkg-deb --build --root-owner-group "${deb_root}" "${deb_asset}"
tar --sort=name --owner=0 --group=0 --numeric-owner -czf "${tar_asset}" -C "${stage_root}" eric-task-master
test -x "${runtime_root}/bin/taskmaster" && test -x "${runtime_root}/runtime/node"
(cd "$(dirname "${runtime_root}")" && zip -q -r -y "${zip_asset}" eric-task-master)
test -f "${deb_asset}" && test -f "${tar_asset}" && test -f "${zip_asset}"
printf '{"ok":true,"target":"%s","signed":false,"assets":["%s","%s","%s"]}\n' "${target}" "${deb_asset}" "${tar_asset}" "${zip_asset}"
