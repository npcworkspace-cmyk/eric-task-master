#!/bin/bash
set -euo pipefail

package="${1:?package path is required}"
state="${RUNNER_TEMP:-/tmp}/eric-task-master-installed-smoke-state"
job="$(cd "$(dirname "$0")/../build/fixtures" && pwd)/bare-playwright-task.mjs"
rm -rf "${state}"
sudo installer -pkg "${package}" -target /
test -x /usr/local/bin/taskmaster
export ERIC_TASK_MASTER_HOME="${state}"
export ERIC_TASK_MASTER_PORT=29846
export NODE_OPTIONS='--require=__eric_task_master_host_injection_must_not_load__'
export NODE_PATH="${state}/__host_node_path_must_not_be_used__"
/usr/local/bin/taskmaster --help >/dev/null
/usr/local/bin/taskmaster status --json >/dev/null
/usr/local/bin/taskmaster profiles create "Upgrade preserved" --json >/dev/null
state_sentinel="${state}/upgrade-state-sentinel.txt"
printf 'preserve-user-state' > "${state_sentinel}"
stale_mcp='/Library/Application Support/Eric Task Master/app/src/mcp/stale-v2.mjs'
stale_pack='/Library/Application Support/Eric Task Master/app/task-packs/stale-v2-pack.mjs'
sudo mkdir -p "$(dirname "${stale_mcp}")" "$(dirname "${stale_pack}")"
printf 'stale-v2-mcp' | sudo tee "${stale_mcp}" >/dev/null
printf 'stale-v2-task-pack' | sudo tee "${stale_pack}" >/dev/null
manager_pid="$(NODE_OPTIONS= NODE_PATH= '/Library/Application Support/Eric Task Master/runtime/node' \
  -p 'JSON.parse(require("node:fs").readFileSync(process.argv[1],"utf8")).pid' "${state}/manager.json")"

sudo installer -pkg "${package}" -target /
attempts=0
while [ "${attempts}" -lt 100 ] && kill -0 "${manager_pid}" 2>/dev/null; do
  sleep 0.2
  attempts=$((attempts + 1))
done
if kill -0 "${manager_pid}" 2>/dev/null; then
  echo 'Upgrade did not stop the previous Manager' >&2
  exit 1
fi
test ! -e "${stale_mcp}"
test ! -e "${stale_pack}"
test "$(cat "${state_sentinel}")" = 'preserve-user-state'
test -x /usr/local/bin/taskmaster
profile_output="$(/usr/local/bin/taskmaster profiles list --json)"
printf '%s\n' "${profile_output}" | grep -Fq '"name":"Upgrade preserved"'

/usr/local/bin/taskmaster profiles create "Installed smoke" --json >/dev/null
task_output="$(/usr/local/bin/taskmaster run "${job}" --label "Installed bare Playwright smoke" --json)"
printf '%s\n' "${task_output}" | grep -Fq '"state":"finished"'
printf '%s\n' "${task_output}" | grep -Fq '"barePlaywrightImport":true'
printf '%s\n' "${task_output}" | grep -Fq '"hostNodeInjectionIsolated":true'
/usr/local/bin/taskmaster manager stop --json >/dev/null
sudo rm -f /usr/local/bin/taskmaster
sudo rm -rf "/Library/Application Support/Eric Task Master"
sudo pkgutil --forget com.npcworkspace.eric-task-master >/dev/null
test ! -e /usr/local/bin/taskmaster
rm -rf "${state}"
unset NODE_OPTIONS NODE_PATH
printf '{"ok":true,"installedRuntime":"bundled-node","nativeUpgrade":"passed","staleV2PayloadRemoved":true,"userStatePreserved":true,"hostNodeInjectionIsolated":true,"barePlaywrightTask":"passed","managerLifecycle":"passed","uninstalled":true}\n'
