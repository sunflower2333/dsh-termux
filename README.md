# dsh-termux

[dsh（DeepSeek Harness CLI）](https://github.com/deepseek-ai/deepseek-harness) 的自包含离线安装包。

**特点**：tarball 内含完整依赖树和预编译原生模块（node-pty / koffi / esbuild / sharp），安装**零构建、零联网**，不需要编译工具链。

## 安装（Termux）

```bash
npm i -g https://github.com/sunflower2333/dsh-termux/releases/latest/download/dsh-termux.tgz
dsh --version   # → 0.1.0-rc.6-termux.3
dsh web         # 启动 Web UI
```

卸载：`npm uninstall -g dsh-termux`

## 要求（Termux）

```bash
pkg install python nodejs-lts
```

- 原生模块按 **Node v24.18.0（nodejs-lts）** 编译，请勿安装 `nodejs`（v26）
- `python` 供 node-gyp 构建原生模块使用

## 已知限制

- **不支持容器 / 沙箱隔离模式**：Termux（Android）上没有可用的沙箱后端（bubblewrap / Landlock 等），dsh 的容器化命令隔离无法启用。
- **运行命令需要授权**：无沙箱环境下，命令执行依赖**手动审批**（Manual Approval）或 **Full Access**（完整访问权限）配置才能正常运行，否则命令会被拒绝执行。

## 重新打包

```bash
ANDROID_NDK_HOME=/path/to/android-ndk-r29 \
	UPSTREAM_VERSION=0.1.0-rc.6 \
	TERMUX_REVISION=4 \
	bash scripts/build-termux.sh
```

构建使用 Android NDK r29、API 24、ARM64。完整补丁说明见 [PATCHES.md](PATCHES.md)。

GitHub Actions 每周一检查 npm 上的 `@deepseek-ai/dsh`。发现新上游版本时会自动应用补丁、交叉编译原生模块、生成离线 npm tarball 并创建 GitHub Release。也可以在 Actions 页面手动运行 `Build Termux release`，勾选 `force` 为当前上游版本递增 `termux.N`。
