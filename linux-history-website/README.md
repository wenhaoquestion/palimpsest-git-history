# Linux History

专门浏览 [torvalds/linux](https://github.com/torvalds/linux) 完整 Git 历史的网站。时间轴覆盖该仓库自 2005 年首次导入以来的完整提交祖先关系；不是 Linux 1991 年以来所有版本控制系统的合并档案。景观采用有明确覆盖标记的有界采样，目录、改动和补丁可按页精确检查。

此目录复用项目根目录的 `src/` 与优化后的 `server/`，不另行维护一套前后端实现。构建生成的 `deploy/` 是独立部署产物，只需要 Node.js 与 Git，不需要 npm 运行时依赖或父项目。

## 本地准备

要求 Node.js 20.19+、Git 2.36+。在项目根目录执行一次 `npm ci` 安装共享构建工具，然后：

```sh
cd linux-history-website
npm run prepare:data
npm run build
npm start
```

打开 [http://127.0.0.1:4180](http://127.0.0.1:4180)。开发模式使用 `npm run dev`，仅监听本机 4181 端口。

数据保存在 `data/linux.git` 裸仓库，无 checkout，不进入 Git 提交或构建产物。`prepare:data` 固定从 torvalds/linux 获取全部分支和标签，不使用 `--depth`；已有浅仓库会执行 `--unshallow`。重复执行会复用已完成的对象。Ctrl+C 取消后可重新执行；被中断的未完成 pack 可能需要重新下载，不能保证字节级续传。

默认使用 `blob:none`：提交和目录树历史完整，文件正文按 Git 的 partial clone 机制按需获取。首次读取旧文件、文件大小、精确改动或补丁时可能产生网络请求，**首次内容读取会明显慢于已有完整本地对象的情况**。生产服务推荐先补齐所有正文：

```sh
npm run prepare:data -- --full
```

从 partial clone 首次执行 `--full` 会重新获取全部可达对象，下载和临时磁盘占用均较大；不要在磁盘空间紧张时执行。成功后记录完整对象状态，后续准备命令增量更新，并保持完整正文模式。完成后相同历史可离线读取。准备脚本会生成 Git commit-graph，加速后续图遍历。已有完整数据且无需联网更新时可执行 `npm run prepare:data -- --offline`。

也可设置运维端环境变量 `LINUX_REPO=/srv/linux.git` 使用已准备的 Linux 裸仓库；启动时验证 upstream、bare 状态和非浅克隆。浏览器没有选择本地路径的接口。

## 独立部署

`npm run build` 会重新构建 Linux 专用前端，并把共享服务的必要文件复制到 `deploy/`。这些副本是构建产物，不是第二套源码。

复制整个 `deploy/` 到服务器，然后在该目录执行：

```sh
# 准备或复用数据；已有镜像时设置 LINUX_REPO 即可。
npm run prepare:data -- --full
HOST=0.0.0.0 PORT=4180 npm start
```

正式域名的 HTTPS 和反向代理由部署环境提供；此项目不会自动创建云资源。持久保存 `data/`，升级时只替换应用文件。数据更新由运维端执行准备脚本，再重启服务；访客不能刷新全局状态。前端静态目录只有 `dist/`，不会暴露裸仓库或服务器源码。

## 公共服务的边界

- 固定 Linux 仓库，一个共享服务和缓存；所有 API 写入方法与 `/api/refresh` 均拒绝。
- 仅允许 `HEAD`、`all`、`master` 与 `refs/heads/master` 历史范围，拒绝任意 revision 表达式，避免重复建立无数全历史索引。
- 公共快照端点只返回有界景观；完整目录和变化走分页接口。公开响应使用 GitHub 地址，不披露本机数据路径。
- 最多 4 个活跃 HTTP API 请求，拥塞返回 `503` 和 `Retry-After`；客户端中途断开仍占用槽位，直到相关计算结束。Git 子进程、排队任务、输出缓存和 LRU 均有上限。
- 共享缓存默认估算预算 48 MiB，Git stdout 双缓冲预算 96 MiB。`npm start` 将 Node V8 heap 上限设为 512 MiB；这些不是总 RSS 或原生 Git 子进程的硬上限。
- 禁用外部 diff 与 textconv，隔离系统/全局 Git 配置；关闭服务会取消 Git 子进程并清理临时历史索引。

Linux 源码及历史保持其各文件与 [COPYING](https://github.com/torvalds/linux/blob/master/COPYING) 中的许可。网站不是 Linux 内核项目的官方服务。

## 验证

```sh
npm test
npm run verify
# 完整 blob 数据准备好后验证早期/中期/末期景观和精确补丁：
npm run verify -- --landscapes
```

验证会检查非浅克隆、百万级真实 Linux 提交图、首提交 `1da177e4c3f41524e886b7f1b8a0c1fc7321cac2`，并随机定位历史页；不会把合成仓库冒充 Linux。带 `--landscapes` 时还检查三个时代的真实目录树与精确补丁。计时、内存和当前 HEAD 写入数据目录旁的 `verification.json`，数值以运行时实际仓库为准。

实现采用 Git 自身的原生对象与图遍历、磁盘固定宽度 OID 索引、按需提交读取及有界采样。更换时间点不需要在浏览器加载整个百万提交历史。

已完成的真实仓库与浏览器验证见 [VALIDATION.md](./VALIDATION.md)。

技术依据：[Git clone 的过滤与浅克隆语义](https://git-scm.com/docs/git-clone)、[Git partial clone](https://git-scm.com/docs/partial-clone)。
