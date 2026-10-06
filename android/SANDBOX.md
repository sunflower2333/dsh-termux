# Android 文件策略与命令授权

Android APK 保留 DSH 默认的 `workspace-write` 文件策略和原有审批策略。
不会因为缺少桌面命令沙盒而把会话切到 `danger-full-access`。

| 能力 | Android APK 行为 |
| --- | --- |
| Android 系统应用隔离 | 使用普通应用 UID 和系统 SELinux 权限，不需要 root；这是应用与其他应用之间的边界。 |
| 文件工具的写入限制 | 保留真实的 DSH 路径检查。`read-only` 拒绝写入；`workspace-write` 只允许规范化后的工作区和平台临时目录。工作区符号链接不能绕过该检查。文件读取不受这个写入检查限制。 |
| Bash 的工作区命令沙盒 | 当前 APK 不支持。DSH 的桌面后端为 bubblewrap、Landlock、Seatbelt 或 Windows ACL，Android 没有可用的默认执行链。不会把应用 UID 隔离标为工作区沙盒，也不会声称 PRoot 提供这一能力。 |
| 受限文件策略下运行 Bash | 首次调用直接通过 DSH 原有审批渠道请求本次命令权限，避免先产生一次“缺少桌面后端”错误。只有 `allowed-once` 才继续；拒绝、取消、审批不可用或调用取消均不启动命令。下一条命令重新请求。 |
| 明确选择完整访问 | 保留 DSH 上游行为。用户选择的 `danger-full-access` 不再限制文件工具写入，也不会由这个补丁增加命令审批。 |

批准的单次 Bash 命令不受工作区边界约束，可以访问 Android 应用 UID 能访问的文件和网络资源。
该批准只传给当前命令，不修改会话、默认文件策略或随后文件工具的策略。
Android 应用隔离与 DSH 文件工具检查是当前可用的替代边界；真正的独立命令工作区需要另接容器、虚拟机或远端执行提供者，本 APK 尚未实现该能力。

补丁只在 APK 的暂存副本中启用，并且要求运行时同时满足
`process.platform === "android"` 和 `DSH_ANDROID === "1"`。
Termux 的构建路径仍调用原有提示补丁，Bash 工具行为保持不变。

```bash
node scripts/patch-android-sandbox.mjs /path/to/staged-package --native-shell
node scripts/test-android-sandbox.mjs /path/to/dsh-package
```

测试使用真实的 DSH Bash 工具定义、单次升级审批算法和文件工具后端。
审批及命令执行使用有界 HOST fixture；文件写入、读回、工作区外拒绝和符号链接拒绝在真实文件系统上运行。
该测试不代替 ARM64 Android 上的审批 UI 与进程运行验证。
