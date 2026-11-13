# DSH 远程控制

**DSH Remote Control** · 代码标识 `dsh-remote-control`

用你自己的一只私有云桶当通道，把手机变成本机 DSH 的远程终端。手机只负责连接，
所有能力、所有数据都留在电脑上。

- **电脑端**：一个 DSH 插件（**仓库根就是那个 bundle 包**，可用 GitHub 链接直接安装）
- **手机端**：一个 76.7KB 的 APK（GitHub Releases 附件，见
  [移动端 v1.0.0](https://github.com/10jinzhi/dsh-remote-control/releases/tag/android-v1.0.0)），
  **只能连接电脑**，没有本机能力

没有配对码、没有 Cloudflare 隧道、没有第三方服务器 —— 只有你自己的桶，
桶里全是密文。

```
手机 APK                                        你的电脑
────────────────                                ─────────────────────
from-phone/<13位序号>.7z    ──┐
                             ├─► Backblaze B2 私有桶 ─► 桥（本插件）
from-desktop/<13位序号>.7z ◄─┘   （每个对象都是 7z）      │
                                                ▼
                                     127.0.0.1:17890 中继
                                                │
                                                ▼
                                       DSH 会话（历史/流式/审批）
```

---

## 快速开始

### 0. 准备一个 B2 桶 + 一把只能读写这个桶的 key

1. 建一个 **Private** 桶（例如 `my-dsh-bucket`）；
2. 建 Application Key，**限定到这一个桶**；
3. 记下 4 个值：`keyID` / `applicationKey` / 桶名 / 「云端文件名」
   （**留空即可**：电脑端默认用本机电脑名派生，例如 `desk-win`）；
4. 再想一个 **7z 密码** —— 它不进桶、不上传，只用来加解密。

> 云端文件名不是文件，是**通道的盐**，也就是「哪台电脑」的身份。
> **两台电脑只要这一项不同，就是两条互不干扰的通道**（其余四项可以完全一样）。

> 用的是**全能力 / 账号级** application key 的话，桶名**必须填**：这种 key 的
> `b2_authorize_account` 不返回 `bucketId`，程序只能拿桶名去 `b2_list_buckets` 定位。
> 另外它一旦泄露，整个账号下所有桶都能被读写 —— 除非你有意为之，建议还是换成
> 限定单桶、Read and Write 的那把。

### 1. 电脑端：装插件

**推荐：在 DSH 官方安装器里用 GitHub 链接装。** 打开 DSH → 设置 → 插件 → 添加，粘贴：

```
https://github.com/10jinzhi/dsh-remote-control
```

想钉死版本就在后面加 `#<tag>` 或 `#<commit>`，例如 `.../dsh-remote-control#v1.0.2`。

> ⚠️ **只钉 `#v1.0.2` 或默认分支。** `v1.0.0` 的客户端入口漏了一句
> `var exports = module.exports`，装上后 web-boot 直接报 `exports is not defined`；
> `v1.0.1` 能启动，但设置面板是一片空白（`style` 传了 CSS 字符串、又用 iframe
> 嵌 host 页面被 CSP 拦）。这两处都只在真机渲染时才暴露，静态检查抓不到。

> ⚠️ **仓库根就是插件包**，这是刻意的：安装器把链接原样交给 `pnpm add`，
> 只校验「装出来的那个包的根 `package.json`」有没有 `dsh.bundle.patch`，
> **不会**扫描 monorepo 子目录。所以 `https://github.com/.../tree/main/某子目录`
> 这种链接会直接被判为非法，根上少一个 `package.json` 就会报 `not-bundle`。
> `package.json` 的 `files` 只放行 `lib/`、`cordis.patch.yml`、`README.md`，
> 仓库里的 APK 源码、工具链、文档都不会被装进 DSH。

> 实测过的账（`pnpm add git+ssh://…`）：pnpm 走的是
> `codeload.github.com/<owner>/<repo>/tar.gz/<sha>`，**下载**的是整仓压缩包
> （当前约 215KB，含 `android/`），但**落进 `node_modules` 的只有 13 个文件**、
> 全部来自 `files` 白名单，`android/` 一个都没进去。所以仓库里带着手机端源码
> 不会污染插件安装，代价只是每次安装多下 ~200KB。

手动装也行：把仓库根的 `package.json`、`cordis.patch.yml`、`lib/` 拷进插件目录，
或者解开 `out/dsh-remote-control-desktop-1.0.2.zip`。

重启 DSH，打开 **设置 → DSH 远程控制**，填那 5 项，点 **测试往返**：

```
✅ 往返正常：打包 → 上传 → 列举 → 下载 → 解密 → 删除 全部通过
耗时 156ms（上传 91ms）
7z 包 266 字节，原文 138 字节
通道 daebed14ba04（指纹 4ca4a668）
```

这一步会真的往桶里写一个加密包再读回来 —— 它是唯一能一次性验证
「密钥对不对、桶对不对、密码对不对、有没有读写权限」的动作。

### 2. 手机端：装 APK

从 **Releases** 下载（仓库里不再放二进制，见下）：

```
https://github.com/10jinzhi/dsh-remote-control/releases/tag/android-v1.0.0
```

直链：`.../releases/download/android-v1.0.0/dsh-remote-control-android-1.0.0.apk`

自己构建出来的在 `out/dsh-remote-control-android-1.0.0.apk`，内容与 Releases 里的一致
（同一份 `build-apk` 产物，发布只是把它当附件传上去）：

```bash
adb install -r out/dsh-remote-control-android-1.0.0.apk
```

> 二进制不进仓库，是为了让 `pnpm add` 拉下来的 tarball 里没有 APK（少 78KB），
> 也避免「库里一份、Releases 一份」迟早不一致。发布用
> `GITHUB_TOKEN=… node tools/publish-release.mjs --tag android-v1.0.0 --apk <apk> --notes docs/发布说明-移动端.md`。

> 别拿旧版覆盖安装：签名指纹是 `669498d0…28ef`，构建用的 keystore 一直没换，
> 所以同签名可以直接升级；若手机上装的是别处来的包，要先卸载再装。

打开应用，填**完全一样**的 5 项，点 **保存并连接**。状态灯变绿 = 已连上电脑。

> APK 需要 Android 8.0+（minSdk 26）。它只申请了网络、前台服务、通知三条权限。

**一台手机可以连多台电脑**：最上面「电脑」卡片里新增一条档案，云端文件名会按
你起的名字自动预填（中文名会退化成 `desk-3f9a2c` 这种短名，可以自己改）；
照抄到那台电脑的设置页即可。每台有自己的配置和收发游标，互不影响。详见
[使用说明 §3.3](docs/使用说明.md)。

### 3. 用

- 右上角齿轮 → 工作区/对话列表 → 点进去看历史、发消息
- 电脑端要你批准命令时，手机会弹出审批卡片
- 通知栏常驻「已连接电脑」，切后台/息屏也不断

---

## 为什么这样设计

| 取舍 | 选择 | 理由 |
| --- | --- | --- |
| 公网通路 | 对象存储邮箱（B2） | 不需要公网 IP、不需要开端口、不需要买 VPS；桶本身就是「公网可达但只有你能读写」的中转站 |
| 加密 | 每次都是标准 7z（AES-256 + LZMA） | 用现成格式而不是自研协议：`7z t` 能验证、任何机器上都能人工取回、两端各自实现也能靠工具互验 |
| 队列 | `from-phone/` 与 `from-desktop/` 两条，各一个生产者 | 目录名由生产者命名，不靠视角区分方向；序号单调递增 ⇒ 不需要分布式锁、不需要 CAS、不需要冲突处理 |
| 事件渲染 | 放在电脑端 | APK 里没有 DSH 知识：升级 DSH 不用重装 APK，手机也不算事件 |
| 密码 | 不参与通道派生 | 密码填错时你应该看到「7z 解不开」，而不是悄悄换到另一条空通道上 |
| 多台电脑 | 手机端存档案，所有键加前缀（`p.<id>.`） | 配置和**游标**一起隔离，不可能出现「配置切了、游标没切」导致漏消息 |

细节都在 **[docs/调研报告.md](docs/调研报告.md)**（含 7z 头部逐字节结构、KDF 配方、
成本测算、安全边界）。

安装步骤与排障在 **[docs/使用说明.md](docs/使用说明.md)**。

---

## 目录结构

```
./                                      电脑端插件（仓库根 = bundle 包，零第三方依赖）
  package.json                         dsh.bundle.patch + files 白名单
  cordis.patch.yml                     insert 一行，让插件进 loader 树
  lib/index.js                         中继 + 插件入口（隧道/配对那套已整块删除）
  lib/mail7z/config.js                 5 项配置 + 通道派生 + 状态
  lib/mail7z/b2.js                     B2 Native API 客户端
  lib/mail7z/sevenz.js                 调系统 7z 打包/解包（stdin/stdout）
  lib/mail7z/mailbox.js                双队列邮箱协议
  lib/mail7z/render.js                 DSH 事件 → 手机气泡
  lib/mail7z/api.js                    手机能调的 app/* 薄 API
  lib/mail7z/bridge.js                 桥：from-phone/ → 中继 → from-desktop/
  lib/mail7z/settings.js               设置页（独立 HTML）+ 测试/清空接口

android/app/src/main/java/dshremote/     手机端核心（**不碰任何 Android API**）
  Config / B2Client / Mailbox / RemoteLink / Json / SelfTest
  z7/SevenZip{Aes,Writer,Reader}.java  纯 Java 的 7z 实现（AES-256 + LZMA）
android/app/src/main/java/dshremote/ui/  界面层（Activity / 前台服务 / JS 桥）
android/app/src/main/assets/index.html 全部界面（单文件，无外部资源）

tools/                                 测试与构建脚本（见下）
docs/                                  使用说明 / 调研报告 / 测试日志
```

## 测试与构建

```bash
node tools/test-all.mjs          # 全量：界面 + 设置接口 + 协议 + APK 构建（约 30s）
node tools/test-all.mjs --real   # 同上，但网络那一层打到真 B2（发版验收）
```

单独跑：

| 命令 | 覆盖什么 |
| --- | --- |
| `node tools/ui-smoke.mjs` | 界面 730 行 JS 在 DOM 桩里真跑一遍：气泡、转义、审批、返回键、多电脑切换、云端文件名预填（18 项） |
| `node tools/settings-smoke.mjs` | 设置页 4 个路由：保存/打码/测试往返/清空 + 默认名两端一致（9 项） |
| `node tools/e2e.mjs` | 传输层：Node 版手机模拟器 ↔ 桥 ↔ 假中继（13 项） |
| `node tools/e2e-app.mjs` | 客户端：**APK 里同一份 Java 核心** ↔ 桥 ↔ 假中继（24 项，含 9 项多电脑断言） |
| `node tools/build-apk.mjs` | aapt2 → javac → d8 → jar → zipalign → apksigner（8 步） |
| `node tools/pack-plugin.mjs` | 打插件 zip，并反查里面没有凭据文件 |

默认全部打到 **本地 B2 兼容桩**（`tools/local-b2.mjs`），不消耗 Backblaze 的
免费 transaction 配额；`--real` 才走真桶。

## 环境要求

- **Node ≥ 20**（用了 `import.meta.dirname`、`node:test` 风格的自建断言）
- **7-Zip**（电脑端要 `7z` 可执行文件；Windows 默认找 `C:\Program Files\7-Zip\7z.exe`，
  可用 `DSH_REMOTE_7Z` 指定）
- **JDK 17**（只在构建 APK / 跑 Java 测试时需要；脚本会自动找 `JAVA_HOME`、
  `~/.jdks/*`、IDEA 自带 JBR）
- **Android build-tools 34 + platform 35** 解压到 `_toolchain/`（见 `docs/使用说明.md`）

## 已知限制

- **B2 免费额度的 transaction 上限是每天 2500 次**。空闲轮询每 4 秒一次列举，
  连续挂着会撞到上限（会看到 `transaction_cap_exceeded`）。要么在
  *Caps & Alerts* 里把上限提上去（500ms 常轮询约 $0.14/天），要么就接受
  「按需点开才连」。细节见调研报告的「成本与配额」一节。
- 一次往返有 1~2 秒的固有延迟（一次列举 + 一次 7z 打包），不适合逐字流；
  流式文字是**按 400ms 批次**到达的。
- 只做了「文本 + 工具名 + 审批」，没有做图片、附件、终端输出的富文本渲染。

## 许可

MIT
