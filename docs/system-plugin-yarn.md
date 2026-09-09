# System Plugin v3 的 Yarn 依赖

Yarn Classic 和现代 Yarn 使用不同的安装命令。`dependencies.packageManager` 为 `yarn` 时，通过 `yarnMode` 显式选择；省略该字段或设为 `classic` 保持 Yarn Classic 行为。该字段是确认 artifact 的一部分，变更后需要确认新 SHA-256。

```json
{
  "dependencies": {
    "packageManager": "yarn",
    "yarnMode": "modern",
    "install": "ci",
    "allowScripts": false,
    "buildCommand": ["yarn", "run", "build"],
    "rebuildNativeModules": false
  }
}
```

插件工程还应在 `package.json` 中声明精确的 `packageManager`（例如 `yarn@4.9.4`），并随包携带对应的 `yarn.lock`。运行 KnowBook 的环境须提供该 Yarn CLI；宿主不会在确认前运行 Corepack、下载工具或执行插件代码。当前现代 Yarn 验收工具链固定为 4.9.4。

现代 Yarn 的 `ci` 对应 `yarn install --immutable --inline-builds`；普通 `install` 则允许生成或更新可变 runtime 中的锁文件。宿主通过 `YARN_ENABLE_IMMUTABLE_INSTALLS` 明确设置两种模式，避免 CI 环境改变声明的安装行为。源目录和已确认 artifact 始终不参与依赖写入。

`allowScripts: false` 增加 `--mode=skip-build`，跳过整个安装构建阶段，同时设置 `YARN_ENABLE_SCRIPTS=false`。只设置后者仍可能执行工作区脚本，因此不能替代该命令参数。`buildCommand` 是另行确认、记录日志的显式构建任务，仍会执行。允许脚本时安装输出直接进入依赖日志，包括根包和依赖包的生命周期输出。[Yarn 安装命令](https://yarnpkg.com/cli/install)

宿主为现代 Yarn 的安装、构建及原生重建任务设置 `YARN_NODE_LINKER=node-modules` 和 `YARN_NM_MODE=classic`，优先于 `.yarnrc.yml` 中的 linker。插件可使用普通 CommonJS/ESM 依赖解析；宿主不在共享 Electron Main 中注册插件的全局 PnP loader。需要 PnP 专有 API 的插件须适配 `node_modules` 模式。Yarn 缓存及全局辅助状态也定向到当前可变 runtime 的 `.yarn`，随 revision 卸载清理。[Yarn 配置](https://yarnpkg.com/configuration/yarnrc)

依赖任务日志记录宿主注入的 Yarn 环境覆盖值，不记录继承的完整进程环境。原生重建属于单独的显式任务，由宿主设置 Electron 的 runtime、target、arch 和 headers 信息；允许该任务会执行原生包的构建脚本。

原生重建分别使用 `npm rebuild`、`pnpm rebuild`、Yarn Classic 的 `yarn install --force --frozen-lockfile`、现代 Yarn 的 `yarn rebuild`。Electron target 同时通过 `npm_config_*` 和 `npm_package_config_node_gyp_*` 传递，适配不同版本的原生构建工具。现代 Yarn 原生包必须在工程依赖中声明其使用的 `node-gyp`，不能依赖全局工具恰好存在；包管理器自己的依赖脚本许可仍需由插件工程配置。

Windows 打包态验收命令：

```powershell
npm run prepare:modern-yarn
npm run test:packaged-modern-yarn
npm run prepare:package-managers
npm run prepare:native-package-managers
npm run test:packaged-native-package-managers
```

验收覆盖取消前零执行、禁止/允许根包与依赖生命周期、显式构建、不可变锁文件、runtime 移动后重启加载、锁文件失败保留 active revision，以及卸载清理。夹具故意声明 `nodeLinker: pnp`，验收实际生成的 `node_modules` 和无 `.pnp.cjs`，从而验证宿主加载策略确实生效。该用例需要先生成当前 Windows unpacked 应用。

原生矩阵先编译真实 Node ABI 的 C++ addon，再验证 Electron 拒绝错误 ABI、针对 Electron 重新编译并加载、编译失败保留旧版本，以及卸载清理。工具和 `node-gyp` 依赖缓存的首次准备需要联网，受测插件随后使用离线缓存。需提供 Python、C++ 工具链和对应头文件；可追加 `-- yarn-modern` 等参数单独执行一种包管理器。
