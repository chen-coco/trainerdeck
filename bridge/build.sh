#!/usr/bin/env bash
set -euo pipefail

configuration="${1:-Release}"
bridge_root="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
repository_root="$(cd "$bridge_root/.." && pwd)"
solution="$bridge_root/TrainerDeckBridge.sln"
artifacts="$repository_root/bin/bridge"
dotnet_command="$repository_root/.tools/dotnet/dotnet"
if [[ ! -x "$dotnet_command" ]]; then
  dotnet_command="dotnet"
fi
export DOTNET_CLI_HOME="$repository_root/.tools/dotnet-home"
export NUGET_PACKAGES="$repository_root/.tools/nuget-packages"

"$dotnet_command" restore "$solution"
"$dotnet_command" build "$solution" --configuration "$configuration" --no-restore

if [[ "$artifacts" != "$repository_root/bin/bridge" ]]; then
  printf 'Refusing to clean unexpected artifact path: %s\n' "$artifacts" >&2
  exit 1
fi
rm -rf -- "$artifacts"
mkdir -p "$artifacts"
cp "$bridge_root/TrainerDeckBridge/bin/$configuration/net35/TrainerDeckBridge.dll" \
  "$artifacts/TrainerDeckBridge.Clr2.dll"
cp "$bridge_root/TrainerDeckBridge/bin/$configuration/net40/TrainerDeckBridge.dll" \
  "$artifacts/TrainerDeckBridge.Clr4.dll"
cp "$bridge_root/TrainerDeckBridgeLauncher/bin/$configuration/net462/TrainerDeckBridgeLauncher.exe" "$artifacts/"
cp "$bridge_root/TrainerDeckBridgeLauncher/bin/$configuration/net462/Mono.Cecil.dll" "$artifacts/"
cp "$bridge_root/trainerdeck-bridge.example.json" "$artifacts/"
cp "$bridge_root/THIRD_PARTY_NOTICES.txt" "$artifacts/"

printf 'Bridge artifacts: %s\n' "$artifacts"
