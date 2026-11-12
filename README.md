# DSH 远程控制

**DSH Remote Control** · 代码标识 `dsh-remote`

用你自己的一只私有云桶当通道，把手机变成本机 DSH 的远程终端。手机只负责连接，
所有能力、所有数据都留在电脑上。

- **电脑端**：一个 DSH 插件（`packages/dsh-remote-desktop`）
- **手机端**：一个 74KB 的 APK（`out/dsh-remote-1.0.0.apk`），**只能连接电脑**，没有本机能力

没有配对码、没有 Cloudflare 隧道、没有第三方服务器 —— 只有你自己的桶，
桶里全是密文。

```
手机 APK                                        你的电脑
────────────────                                ─────────────────────
in/<13位序号>.7z  ──┐
                    ├─► Backblaze B2 私有桶 ─► 桥（本插件）
out/<13位序号>.7z ◄─┘   （每个对象都是 7z）      │
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
3. 记下 4 个值：`keyID` / `applicationKey` / 桶名 / 自己起一个「云端文件名」
   （例如 `dsh-remote`）；
4. 再想一个 **7z 密码** —— 它不进桶、不上传，只用来加解密。

> 云端文件名不是文件，是**通道的盐**。改它等于换了一条通道（旧消息不会跟过来）。

### 1. 电脑端：装插件

```bash
# 方式一：直接放进插件目录
cp -r packages/dsh-remote-desktop <你的 DSH 插件目录>/
# 方式二：用打好的 zip
#   out/dsh-remote-desktop-1.0.52-remote.1.zip
```

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

```bash
adb install -r out/dsh-remote-1.0.0.apk
```

打开应用，填**完全一样**的 5 项，点 **保存并连接**。状态灯变绿 = 已连上电脑。

> APK 需要 Android 8.0+（minSdk 26）。它只申请了网络、前台服务、通知三条权限。

**一台手机可以连多台电脑**：最上面「电脑」卡片里新增一条档案、填那台的 5 项即可，
下拉就切换。每台有自己的配置和收发游标，互不影响。详见
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
| 队列 | `in/` 与 `out/` 两条，各一个生产者 | 序号单调递增 ⇒ 不需要分布式锁、不需要 CAS、不需要冲突处理 |
| 事件渲染 | 放在电脑端 | APK 里没有 DSH 知识：升级 DSH 不用重装 APK，手机也不算事件 |
| 密码 | 不参与通道派生 | 密码填错时你应该看到「7z 解不开」，而不是悄悄换到另一条空通道上 |
| 多台电脑 | 手机端存档案，所有键加前缀（`p.<id>.`） | 配置和**游标**一起隔离，不可能出现「配置切了、游标没切」导致漏消息 |

细节都在 **[docs/调研报告.md](docs/调研报告.md)**（含 7z 头部逐字节结构、KDF 配方、
成本测算、安全边界）。

安装步骤与排障在 **[docs/使用说明.md](docs/使用说明.md)**。

---

## 目录结构

```
packages/dsh-remote-desktop/          电脑端插件（零第三方依赖）
  lib/index.js                         中继（复制自隔壁插件，只改了入口与配对方式）
  lib/mail7z/config.js                 5 项配置 + 通道派生 + 状态
  lib/mail7z/b2.js                     B2 Native API 客户端
  lib/mail7z/sevenz.js                 调系统 7z 打包/解包（stdin/stdout）
  lib/mail7z/mailbox.js                双队列邮箱协议
  lib/mail7z/render.js                 DSH 事件 → 手机气泡
  lib/mail7z/api.js                    手机能调的 app/* 薄 API
  lib/mail7z/bridge.js                 桥：in/ → 中继 → out/
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
| `node tools/ui-smoke.mjs` | 界面 730 行 JS 在 DOM 桩里真跑一遍：气泡、转义、审批、返回键、多电脑切换（17 项） |
| `node tools/settings-smoke.mjs` | 设置页 4 个路由：保存/打码/测试往返/清空（8 项） |
| `node tools/e2e.mjs` | 传输层：Node 版手机模拟器 ↔ 桥 ↔ 假中继（13 项） |
| `node tools/e2e-app.mjs` | 客户端：**APK 里同一份 Java 核心** ↔ 桥 ↔ 假中继（20 项，含 5 项多电脑隔离） |
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
