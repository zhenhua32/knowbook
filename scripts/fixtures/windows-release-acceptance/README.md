# Windows 插件 v3 发布验收

本目录说明安装包和真实登录/重启验收。脚本存在不代表验收通过；最终证据必须来自实际运行。

## 本机可以独立运行的检查

1. `npm run pack`：构建当前应用并生成 Windows unpacked 包。
2. `npm run test:packaged-uninstall-cleanup`：验证真实 `--knowbook-uninstall-cleanup` 维护进程，要求受控插件的 activate/deactivate 调用记录不变、已登记登录项和 detached PID 被清理、用户数据保留、再次执行幂等、普通重开后插件保持 disabled。
3. `npm run prepare:windows-installer`：仅在临时 staging 中安装依赖并生成两个真正的 NSIS 包。每轮随机生成独立 appId、NSIS GUID、package name、产品名与 exe 名，不会发布、安装或改动正式 KnowBook。两个包应用版本分别是当前版本与 patch +1，Electron ABI 相同；不同 ABI 由既有 host-upgrade 验收单独覆盖。
4. `npm run test:packaged-windows-installer`：用刚生成的 `release/windows-installer/fixture.json` 执行首次安装、经本地 HTTP feed 的真实 electron-updater 升级、NSIS 安装器回退、保留数据卸载、重新安装并保留 disabled 状态、`--delete-app-data` 卸载。检查安装注册、进程、Run/StartupApproved、用户数据保留或删除的对应语义。结果在 `release/acceptance/windows-installer-live`，与其他 Playwright runner 的输出目录隔离。未运行或者失败时不能宣称 NSIS 门槛已完成。

Windows CI 顺序准备固定版本 pnpm/Yarn Classic、现代 Yarn 与其 native 依赖缓存，执行普通依赖和原生重编译矩阵、十二类能力、激活故障恢复、维护 CLI、真实宿主 ABI 切换及独立 NSIS 安装器验收；结果分别写入 `test-results/**` 或 `release/acceptance/**`，并上传宿主升级和安装器 fixture 元数据。通用 validate job 另执行 `npm run typecheck:system-plugin-examples`。CI 不执行整机注销或重启；下面两项仍需在隔离 VM 中分别收集证据。

安装器在更新/替换安装时通过 `--updated` 调用旧卸载器，保留插件确认、后台状态和用户数据。真正卸载先运行宿主维护 CLI；失败时中止，保留应用供重试。维护入口只使用宿主持久化元数据，不激活插件、不执行插件 deactivate 或第三方卸载脚本；其能力限于通过宿主登记的启动项和可核验进程，不承诺清理由 Full Trust 插件绕过 SDK 创建的任意副作用。

## 真实 Windows 登录和重启

仅在已准备好的、可销毁的 Windows VM 中执行。脚本不会注销或重启计算机，也不配置自动登录、不存储账户密码、不启动/停止虚拟机。2026-09-09 本机没有 WindowsSandbox.exe，Hyper-V 服务存在但当前身份无权枚举虚拟机；因此本机不具备已核实可用的隔离真实登录/重启执行环境。

1. 在 VM 中安装独立验收身份，运行 `npm run prepare:windows-session -- <已安装exe的绝对路径> <隔离profile的绝对路径>`，生成唯一 ID 的受控插件与两份 checkpoint。以输出的 profile 启动宿主（`--knowbook-user-data-dir=<绝对路径>`），在插件中心选择生成的插件目录并确认精确 artifact；重启宿主后再单独确认登录启动项，等待服务 RPC 正常。该夹具单次进程有十分钟期限，验证应在启动后十分钟内完成。
2. 生成的 checkpoint JSON 使用以下格式，也可手动创建并替换为 VM 中的实际绝对路径及插件 ID：

   ```json
   {
     "kind": "knowbook-windows-session-acceptance",
     "executable": "C:\\Fixture\\KnowBookAcceptance.exe",
     "profile": "C:\\FixtureProfile",
     "pluginId": "system.e2e.session-fixture"
   }
   ```

3. `npm run capture:windows-session -- C:\\Fixture\\login-checkpoint.json`。保存当前机器、OS boot time 和当前 logon identity 的散列、精确 Run 命令、进程身份、服务 RPC。
4. 由 VM 操作者在 VM 内注销并重新登录，不手动打开应用或重放 Run 命令。执行 `npm run verify:windows-session -- C:\\Fixture\\login-checkpoint.json login`。验证同次 OS boot 中 logon identity 已改变、新宿主带精确启动参数运行、正确 profile 的服务 RPC 新鲜。
5. 创建新的 reboot checkpoint、再次 capture，在 VM 内重启后登录，执行 `npm run verify:windows-session -- <checkpoint> reboot`。验证 OS boot time 已改变，不会把应用重启或命令重放计为系统重启。
6. 在 VM 内执行安装包升级/回退/卸载，再检查本机安装器矩阵的相同项目；保留原始 checkpoint、JSON 证据、安装器 hashes 和 VM 操作记录。登录与重启必须分别提供证据。

观察脚本本身不会启动 KnowBook；不得在 capture 到 verify 之间手动启动宿主，避免把人工启动误作系统启动。仅有已登记 Run 值、手工重放命令或一个有运行意图的文件都不构成系统登录/重启通过的证据。
