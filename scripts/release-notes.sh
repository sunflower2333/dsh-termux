#!/usr/bin/env bash
set -euo pipefail

version="$1"
upstream="$2"
asset="dsh-termux-${version}.tgz"
sha256="$(cut -d ' ' -f 1 "dist/${asset}.sha256")"

cat <<EOF
# dsh-termux ${version}

基于上游 \`@deepseek-ai/dsh@${upstream}\` 的 Termux/Android ARM64 离线安装包。

## 安装

\`\`\`bash
pkg install nodejs-lts
npm i -g https://github.com/${GITHUB_REPOSITORY}/releases/download/v${version}/${asset}
dsh --version
dsh web
\`\`\`

包内包含完整依赖树，以及 Android ARM64 的 koffi、node-pty、esbuild 和 sharp WASM 运行时。

SHA-256: \`${sha256}\`
EOF
