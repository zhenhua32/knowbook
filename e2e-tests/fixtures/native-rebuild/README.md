# Native 源码重编译验收夹具

这个最小 C++ addon 使用与运行时版本绑定的 `NODE_MODULE_VERSION`，导出编译时 ABI 和数值 `42`。它不使用跨版本兼容的 Node-API，以便真实验证错误 ABI 拒绝和 Electron 重编译。

`e2e-tests/system-plugins-native-rebuild.spec.ts` 会复制本目录到临时目录，生成 v3 manifest，并依次验证：

1. 为运行 Playwright 的 Node 编译 addon，读取其真实 ABI。
2. 未启用 rebuild 时，打包 Electron 拒绝加载这个不同 ABI 的文件。
3. 用户确认启用 native rebuild 的新 artifact 后，宿主运行 `npm ci --ignore-scripts` 和针对当前 Electron 的 `npm rebuild`。
4. 原 artifact 中的旧二进制保持不变；重启后从可变 runtime 加载新编译文件，其导出 ABI 必须等于 Electron ABI。
5. 使用受控 C++ 编译错误验证任务失败、编译器日志保留和当前可用版本继续运行，随后卸载所有成功及失败 revision。

验收要求 Node.js、npm、Python、C++ 工具链及 Node/Electron 头文件；Windows 使用 Visual Studio C++ 工具，macOS 使用 Xcode Command Line Tools，Linux 使用 make 和 C++ 编译器。首次构建可能下载官方头文件；npm 安装自身没有远程依赖。

从仓库根目录运行：

```sh
npm run pack
npm run test:packaged-system-plugins
```

`KNOWBOOK_E2E_EXECUTABLE` 可指定打包应用。Python 不在 PATH 时可设置 `PYTHON` 或 `NODE_GYP_FORCE_PYTHON` 为本机 Python 的绝对路径。用例以 `@native-build` 标记，普通 `@electron` 回归不会要求额外的源码编译工具；Windows 打包 CI 显式包含此用例。当前验收范围不要求 macOS/Linux 实测。

JSON 证据和编译日志写入 `test-results`，测试结束会清理临时源码和用户目录。本用例验证 Node → Electron 的真实 ABI 重编译。

另有 `e2e-tests/system-plugins-host-upgrade.spec.ts` 复用本源码，验证同一已确认插件在不同 Electron 宿主之间升级和回退：

```sh
npm run prepare:host-upgrade
npm run test:packaged-host-upgrade
```

准备脚本在独立临时目录安装应用依赖并针对 Electron 36.0.0 打包，输出至 `release/host-upgrade`，不会重建仓库或基线包的原生依赖；运行前需已有基线 unpacked 包及最新 `out`。`KNOWBOOK_E2E_UPGRADE_ELECTRON_VERSION` 可指定其他完整版本，`KNOWBOOK_E2E_UPGRADE_EXECUTABLE` 可复用现有目标包。测试要求新宿主具有更高主版本及不同 ABI，相同版本/ABI 会明确失败。

宿主测试以 `@host-upgrade` 标记，复用同一临时 userData 验证自动 rebuild、原确认复用、数据保留、artifact 不变、回退重编译、相同宿主再次启动不重复编译及卸载清理。JSON 和编译日志保存在 `test-results/host-upgrade`。此验收更换的是真实 Electron 可执行文件，不涉及自动更新器或 NSIS 安装。
