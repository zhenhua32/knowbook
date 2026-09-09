# 从 SQLite 安全备份恢复 KnowBook（Windows）

系统插件可能直接修改数据库。插件版本回滚只恢复代码；要恢复文档、表结构或设置，需使用安装/升级时生成的 `.db` 安全备份。插件中心显示“安全备份”路径，通常位于当前工作区的 `backups/system-plugins`。设置中的“从备份目录恢复”用于 Markdown 导入，不能代替本流程。

## 执行恢复

完全退出使用该工作区的 KnowBook，然后在 PowerShell 中运行以下命令。将三个绝对路径替换为实际应用、工作区和备份位置；工作区是含 `storage/knowbook.db` 的 userData 目录，不是 Markdown 导出目录。

```powershell
$appExe = 'C:\Users\你的用户名\AppData\Local\Programs\KnowBook\KnowBook.exe'
$workspace = 'C:\Users\你的用户名\AppData\Roaming\KnowBook'
$backup = 'C:\Users\你的用户名\AppData\Roaming\KnowBook\backups\system-plugins\实际备份文件.db'
& $appExe "--knowbook-user-data-dir=$workspace" "--knowbook-restore-database=$backup"
```

恢复进程只执行维护操作，成功后退出。结果写入工作区的 `database-restore-result.json`：`status: "restored"` 表示成功，`recoveryDirectory` 是本次原始文件及记录的位置。随后以同一工作区重新打开应用：

```powershell
& $appExe "--knowbook-user-data-dir=$workspace"
```

首次打开跳过 Legacy v1、v2 与 Full Trust v3 自动激活；恢复出的 v3 installation 还会持久设置为安全停用，后续也不会自动激活。先检查知识库与插件错误，再从插件中心逐一启用可信版本。Legacy/v2 的暂停仅针对恢复后的首次启动，后续采用其已有配置。

## 恢复时会发生什么

1. 获取该工作区的单实例锁，在打开 Store、运行插件或启动工作线程之前处理恢复。重复参数、相对路径、与卸载维护命令混用都会拒绝。
2. 复制备份到目标存储目录，核对 SHA-256；检查 SQLite 完整性、外键、KnowBook 核心表列以及当前应用支持的 schema 版本。非 KnowBook 数据库、新版本数据库和带活动 WAL 的源文件会拒绝。备份源不被打开写入或修改。
3. 从现有数据库的独立快照读取后台服务身份，并与 Windows 实际 PID、创建时间、可执行文件及服务入口核对。只停止能够核验的托管服务并等待退出。数据库本身损坏但没有该工作区的服务运行时，仍可恢复。
4. 将当前 `knowbook.db` 及存在的 `-wal`、`-shm` 文件保留到 `backups/database-restore/<本次ID>/original`；替换使用同卷暂存文件的原子重命名。普通失败会把原文件移回，原始损坏文件也会完整保留。
5. 替换操作带持久日志。若进程在替换途中中断，下次启动先根据 `database-restore-pending.json` 回退未完成的替换，或确认已完成的替换，再打开 Store。若已提交的候选数据库损坏或丢失，只有完整原文件仍在时才退回，并隔离候选 WAL/SHM、保留安全启动标记；原文件不完整会阻断并保留日志。卸载维护也先处理未完成的恢复。不要手工删除该日志或原始文件目录。

恢复覆盖当前数据库中的文档、设置、插件状态等内容，恢复点之后的数据库变化会退回备份时间。`storage/assets`、插件 `data` 文件、外部目录及第三方服务不会随数据库恢复而回退。原始 DB/WAL/SHM 和源备份保留供进一步检查。

## 失败处理

错误会通过原生错误对话框显示；维护进程返回非零退出码，并尽可能在 `database-restore-result.json` 写入原因。单实例锁冲突为 23，恢复失败为 25，启动时无法安全完成日志处理为 26。

若提示后台 PID 无法核验，说明还有可能访问该工作区的服务。先退出对应服务，或重启 Windows 后在其他 KnowBook 实例启动前重试。不要按一个过期 PID 随意终止进程。对绕过宿主管理、自行启动的外部进程，宿主无法保证自动识别与清理。

若备份 schema 比应用新，使用创建备份的同版本或兼容的新版本 KnowBook。若完整性校验不通过，选择更早的安全备份。若报告回退未完成，保留整个工作区、恢复目录和日志，不要再在线覆盖数据库。
