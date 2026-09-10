# Windows 真实登录与系统重启验收

> 状态：未执行，留待用户后续手测。2026-09-10 用户明确表示当前不具备真实登录和重启条件，暂不执行；本项不再阻塞插件 v3 本次目标完成。

此验收补充已有的 Windows Run 注册和命令重放测试，当前尚未在真实会话切换后执行。本文仅覆盖 Windows；macOS/Linux 实测按此前用户要求排除。后续具备条件时，请在可丢弃的独立测试机或 VM 中操作，使用独立安装身份和隔离工作区；准备及采集脚本不会注销、重启、启动应用或登记登录项。

## 准备

将仓库和独立测试安装器放入 VM，完成安装后运行以下命令，用实际绝对路径替换示例：

```powershell
npm run prepare:windows-session -- 'C:\Acceptance\KnowBookTest.exe' 'C:\Acceptance\Profile'
```

脚本生成随机插件目录及 `login-checkpoint.json`、`reboot-checkpoint.json`，并打印绝对路径。用 `--knowbook-user-data-dir=C:\Acceptance\Profile` 启动测试应用，在插件中心选择生成的插件，完成精确 artifact 确认并重启激活，然后单独确认登录启动。待服务状态为 ready 且 RPC 成功。

## 登录与重启

1. 运行 `npm run capture:windows-session -- '<生成目录>\login-checkpoint.json'`，保存当前机器、启动时间、登录会话、精确 Run 命令和服务状态。
2. 在 VM 中正常注销并重新登录同一个测试用户；不要手动打开应用或重放 Run 命令。
3. 待 Windows 登录启动完成后，运行 `npm run verify:windows-session -- '<生成目录>\login-checkpoint.json' login`。
4. 对 `reboot-checkpoint.json` 重新执行 capture，然后在 VM 内重启系统并登录，运行 `npm run verify:windows-session -- '<生成目录>\reboot-checkpoint.json' reboot`。

校验要求同一台机器；登录场景要求登录身份改变且系统启动时间不变，重启场景要求系统启动时间改变。两种场景都必须观察到 capture 后启动的精确插件/工作区宿主命令，以及活着的服务进程和新的 RPC 成功记录。旧快照或仅重放命令不满足标准。采集文件只保存机器/会话标识的哈希。

## 清理与记录

保留 checkpoint 及 verify 输出的证据路径。从插件中心移除登录启动，停止服务并卸载插件；再运行独立安装器的卸载程序。确认对应 Run/StartupApproved 值、服务和测试安装均已移除，最后丢弃 VM。独立 NSIS 自动化验收入口为 `npm run test:packaged-windows-installer`，它覆盖更新器升级、回退和两种用户数据卸载选项，不触发操作系统会话切换。

在两个 verify 均通过并保存清理证据前，不应把真实 Windows 登录/系统重启标记为完成。
