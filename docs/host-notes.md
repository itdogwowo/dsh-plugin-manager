# 宿主行為實測記錄（M0）

> **這份文件是宿主行為的唯一真相來源。**
> `src/host/host.mjs` 裡的每一條假設，都必須能在這裡找到對應的實測記錄與命令。
> 宿主升級後 `doctor` 要重跑這份清單；簽名一變就 fail-loud。
>
> 狀態：**進行中**。A1 / A2 / A3（一半）/ A4 / A7 已有實測答案；
> **T4 已完成（答案是否定的）；T2 的問題形式已被 F7 改寫**（宿主半拿不到
> `node:child_process`，要問的不是「能不能」而是「該不該用 `subprocess` 服務」）。
> A5 / A6 / A8 待驗（見最後一節）。
>
> ⚠️ **本節所有 `[測]` 都是在真實 `web` profile 上「唯讀」做的**，
> 沒有寫入任何 profile 檔案。需要造壞情境的（A5/A6）一律留到 throwaway profile。

## 環境

| | |
|---|---|
| 日期 | 2026-09（實測當日） |
| 作業系統 | Windows |
| `dsh --version` | **`0.1.5-rc.3`**（＝ `@deepseek-ai/dsh` 套件版本） |
| `node --version` | `24.14.1` |
| DSH 安裝根 | `<checkout>` ＝ npx 快取的 `node_modules/@deepseek-ai/` |
| DSH CLI 進入點 | `<checkout>/dsh/lib/bin.js` |
| 測試用 profile | `web`（**唯讀**；造壞情境時改用 throwaway） |

**受測 profile 的形狀**（後面解讀 dump 會用到）：

- `dsh.profile.bundles` 8 條：`@deepseek-ai/dsh-base`、`@deepseek-ai/dsh-web-app`，
  加 6 條社群套件（npm／`link:`／tarball URL 混合）
- `dependencies` 7 條——**bundles 與 dependencies 條數不相等，這是正常的**

> ⛔ **版本警語**：`0.1.5-rc.3` **不是**最新版。生態裡多個插件已要求 `>=0.1.7-rc.1`，
> 而 `0.1.7` 之後多了官方 `/plugin-installer`、`/plugin-control` 通道（見 A4）。
> **宿主升級後這份文件全部 `[測]` 都要重跑。**

---

## A1 ⛔ `--dump-config` 在 bundle 缺檔／壞檔時會 throw

**為什麼重要**：決定 `verify` L1 捉不捉得到「依賴存在但檔案不見了」這類故障。

**結論**：✅ **成立，但必須加一條重要更正。**
throw 的觸發條件是 **bundle 根本沒裝**（`:831`）或 **bundle 沒有 `dsh.bundle`**（`:852`）——
**不是**「模組解析失敗」。指向不存在套件的 row，V1 完全看不到（見〈額外發現 F3〉）。

`[碼]` `dsh-app-boot/lib/index.js:843-871`：

```js
const packageDir = resolveBundleDir(binName, packageName, installAnchor, dir)   // :850
const declared = JSON.parse(readFileSync(join(packageDir, "package.json"), "utf8")).dsh?.bundle?.patch
if (declared === void 0) throw ...                                            // :851-852
```

`[測]` 對照組（用 `--patch` 餵 overlay，不動真 profile）：

| 情境 | exit | stdout |
|---|---|---|
| 正常 `--profile web --dump-config` | **0** | 17,653 B / 561 行 / 122 ms |
| `--patch` 插入指向不存在套件的 row | **0** | 17,793 B（那行原樣出現） |
| `--patch` 餵語法壞的 YAML | **1** | 0 B |

**⬜ 仍待驗**：`node_modules` 被刪之後 `resolveBundleDir` 會不會落到 profile 裡的
`.dsh-module-fallback` 而仍然成功 → 見待辦 T3。在那之前，
「`missing-module` fixture 是否 V1 捉得到」保持未定。

---

## A2 `--dump-config` 輸出含每個 entry 的模組 specifier

**為什麼重要**：`verify` 要靠它抽出 specifier 去做模組解析檢查。

**結論**：✅ **成立。** 每條 row 都帶 `name:`（模組 specifier）。

`[測]` 實際輸出（節錄 3 條）：

```yaml
- id: dsh-power
  name: dsh-power
- id: better-sidebar
  name: dsh-better-sidebar
- id: timer
  name: '@deepseek-ai/cordis-plugin-timer'
```

⚠️ **但有一個陷阱**：`disabled:` 欄位是**未求值的 `!!js` 原始表達式**，不是布林值。

```yaml
# == dsh-better-sidebar
- id: better-sidebar
  name: dsh-better-sidebar
  disabled: !!js >-
    [...ctx.loader.entries()].some((e) => e.options.name ===
    'dsh-better-sidebar' && e.options.id !== 'better-sidebar' && !e.disabled)
```

`[碼]` `dump-config-*.js:6-10` 明講 compose 而 **without booting or evaluating `!!js`**。

> **推論**：「這行到底有沒有啟用」**不能靠 V1 判斷**。要真實狀態就走
> `pluginInventory`（〈額外發現 F2〉），或自己做同樣的判斷。

---

## A3 ⛔ 插件可以在宿主內 spawn `dsh` 子進程

**為什麼重要**：**這是「裝之前驗證」的地基。** 如果不可以，核心價值要大改。

**結論**：🟡 **問題形式已被 F7 改寫。**

- 從**一般 PowerShell 進程**：✅ 可以（見下表第 4 項）
- 從**宿主半內用 `node:child_process`**：❌ **不可能**——宿主半的 builtin 清單裡
  沒有 `require`／`import`，拿不到任何 Node 模組（F7）
- 從**宿主半內用 `subprocess` 服務**：⬜ 未測（T2）

⇒ **真正的問題不是「能不能 spawn」，而是「該不該」。**
`clientModules.graph()`（F7）已經提供大部分本來要靠 `--dump-config` 才能拿到的資料，
而且**免子進程、免沙箱、免 122 ms**。`subprocess` 只在「真的要離線 compose 預檢」
（V1）時才需要，而且必須走宿主服務 ＋ `jobs`，不是 raw child process。

要驗四件事的現況：

| 要驗 | 現況 |
|---|---|
| 1. 不死鎖 | ⬜ 未測（T2，改用 `subprocess` 服務） |
| 2. 不搶 port | ⬜ 未測；但 `--dump-config` 不 boot，理論上不開 port |
| 3. 不污染環境 | ⬜ 未測；唯讀實測中它沒有改動任何 profile 檔案 |
| 4. 拿得到 stdout / exit code | ✅ `[測]` `Start-Process -RedirectStandardOutput` 拿得到完整 stdout 與 exit code |

**⇒ 對 M1 的影響：零。** M1 的唯讀面板完全不需要子進程（它用 `clientModules`）。
T2 只阻塞 M4（安裝／回滾）。

`[測]` 可用的呼叫形式與結果：

```powershell
& 'C:\Program Files\nodejs\node.exe' `
  '<checkout>\dsh\lib\bin.js' `
  --profile web --dump-config
# exit=0  stdout=17653 B（561 行）  stderr=0 B  elapsed_ms=122
```

### ⚠️ 一個必須先解決的前置問題：Windows 上 `dsh` 不是執行檔

```powershell
Start-Process dsh ...
# → Start-Process: 因為發生錯誤，所以無法執行此命令: %1 不是有效的 Win32 應用程式。
```

`Get-Command dsh` 回傳的是 **`dsh.ps1`（ExternalScript）**。

> **⇒ 宿主半不可依賴 PATH 上的 `dsh`。** 必須解析到 `<checkout>/dsh/lib/bin.js`
> 再用宿主自己的 Node（`process.execPath`）執行，或走 `cmd.exe /d /s /c` 的 shim 封套。
> 參考實作 `dsh-web` 的 `findDshBinary` 就是為此存在（PATH → `node_modules/.bin`
> → 宿主自身 `lib/bin.js` 的回退鏈）。

`[碼]` `dsh/lib/bin.js` 的旗標形狀（實作時會踩到的細節）：

| 事實 | 位置 |
|---|---|
| `--dump-config` 是**頂層**旗標 | `:85` |
| `--patch <path>` 可重複（single-value collector，非 variadic） | `:24-25,85` |
| `--dump-config` 與 `--dump-default-config` 互斥 | `:63` |
| `--dump-default-config` 不接受 `--patch` | `:66` |
| `plugin` 子命令的 `--profile` 是**子命令自己的** requiredOption | `:106` |
| `web` 是 `--profile web` 的硬編碼別名 | `:19,100` |

---

## A4 ⛔ 官方 host 通道可以由插件觸發安裝

**為什麼重要**：決定要不要自己 spawn pnpm。

**怎麼看**：讀 `@linxin666/dsh-client-ui-plugin-manager` 的實作，看它用哪個服務。

**結論**：❌ **在本機不成立——沒有官方通道可用，只能 spawn CLI。**

`[測]` 本機 `0.1.5-rc.3` 對 `/plugin-installer`、`/plugin-control`、
`pluginInstaller` 全部 **grep 零命中**。

`[碼]` 參考實作把它寫成**雙通道**，而且第二條通道就是為了這種情況存在的：

> 「帶官方安裝器服務的運行時（DSHCode 與 1.0.4 checkout 版 web）走官方
> `/plugin-installer`、`/plugin-control` loopback RPC 通道；**npm 發布的官方 web
> 沒有這些通道**，本包的 host 半區掛載 loopback 門禁的 HTTP 網關——安裝/卸載
> **spawn 官方 `dsh plugin` CLI（唯一寫入器）**。」

它的 gateway 就是那條 CLI 路徑，argv 形狀：

```
install / update : ['plugin', '--profile', <n>, 'add', <spec>]
remove           : ['plugin', '--profile', <n>, 'remove', <id>]
```

> **⇒ 對本插件的意義**：官方通道版本要求 `>=0.1.7-rc.1`；本機 `0.1.5-rc.3` 沒有。
> 所以 `plan.md` §6.4 的「forward 官方 host 安裝通道」在**本機這一版**
> 必須改寫成「spawn `dsh plugin` CLI」。
> **同時**：這也讓 R2（只依賴 `webServer`）從「限制」變成「本來就沒得選」——
> 沒有官方安裝服務可以依賴。

---

## A5 裝完之後，不重啟也拿得到新 bundle 的 patch 檔內容

**為什麼重要**：決定「裝後即驗」是同一個動作內完成，還是要延到下次啟動。

**結論**：⬜ **未測**（待辦 T6）。必須在 throwaway profile 上做。

**已有間接證據**（`[測]`，唯讀）：`node_modules/<n>/package.json` 與
`node_modules/<n>/cordis.patch.yml` 都是**普通磁碟檔案**，不經過任何快取：

```
node_modules/dsh-worktable/package.json   → version: 0.3.3
```

`[碼]` 宿主讀 bundle patch 的路徑也是直接讀檔（`dsh-app-boot/lib/index.js:851-853`），
沒有任何記憶體快取。→ **強烈傾向「拿得到」**，但仍需實測確認沒有 inode / hardlink 陷阱。

---

## A6 一個「壞鄰居」會不會讓本插件也載入不了

**為什麼重要**：直接影響 §9.3 的測試設計，以及 README 要怎麼描述可靠性。

**結論**：⬜ **未測**（待辦 T7）。

**已可引用的宿主證據**（`[碼]`）：

- `dsh-app-boot/lib/index.js:1438` — 樹 settle 之後才統一審計：
  `plugin(s) failed to load: <names>; Cordis startup failed because these plugin(s)
  could not be resolved`。**這是「先全部嘗試、最後才報」**，不是第一個失敗就中止。
- `dsh-app-boot/lib/index.js:1407` — 進程級 `fatal load failure` → `exit(1)`。

> 但「settle 後審計」不等於「本插件不受影響」——若那個壞鄰居讓整個進程 exit(1)，
> 本插件也一起死。所以這條**必須實測**，不能從程式碼推論。

---

## A7 語法錯誤的 `--patch` 檔會讓 boot throw

**為什麼重要**：確認 R5（生成的 patch 檔必先自我驗證）的必要性。

**結論**：✅ **會 throw。R5 必須保留。**

`[測]` 用一個縮排壞掉的 overlay：

```yaml
- insert:
    - id: probe-bad-syntax
   name: 'unbalanced-indent'
```

```powershell
& node <checkout>/dsh/lib/bin.js --profile web --patch <ov> --dump-config
# exit=1  stdout=0 B  stderr=1387 B
```

stderr 開頭：

```
Error: dsh: failed to parse overlay <file>: YAMLException: bad indentation of a mapping entry (4:4)
```

`[碼]` 對應 `dsh-app-boot/lib/index.js:1197`：

```js
throw new Error(`${binName}: failed to parse ${label} ${file}: ${String(error)}`);
```

> **⇒ R5 的「生成的 patch 檔必先自我驗證」有直接根據**：
> 餵壞 YAML 進 `--dump-config` 會拿到**非零 exit ＋ 可讀訊息**，
> 所以在**寫入磁碟之前**就能攔下來。

---

## A8 面板未打開時真的零請求

**為什麼重要**：R4 的核心。用 fetch 監聽釘死。

要釘死的三件事：
1. `apply()` 階段：零請求
2. 掛載階段：零請求
3. 按下「顯示面板」之後：剛好一個請求

**結論**：⬜ **未測**（待辦 T8，屬 M1 驗收）。

---

## 額外發現（不在原 §10 假設裡，但直接影響架構）

### F1 `--dump-config` 的層標記揭露「哪個 bundle 提供這條 row」

`[測]` dump 用註解行分段，兩種格式：

```
# == <origin>
# == <origin>, patched by <bundle>[, <bundle>...]
```

真實 profile 的 8 條（節錄）：

```
# == @deepseek-ai/dsh-base
# == @deepseek-ai/dsh-base, patched by @deepseek-ai/dsh-web-app
# == @deepseek-ai/dsh-base, patched by @liustack/modsearch
# == @deepseek-ai/dsh-web-app
# == dsh-worktable
```

`[碼]` 產生處：`dsh-app-boot/lib/index.js:1290`（`# == ${currentLabel}`）與
`:1301`（`${record.origin}, patched by ${record.patchedBy.join(", ")}`）。

> **用途**：面板要顯示「這條 row 是誰帶進來的、被誰改過」，
> **dump 的層標記就是答案**，不必自己拼 bundle 疊層。

### F2 官方 `pluginInventory` 服務已經在本機提供

`[碼]` `<checkout>/dsh-host-plugin-inventory`（`0.1.5-rc.3`）
匯出 `PluginInventoryGateway`：

```js
static inject = ["loader"]                            // :91
constructor(ctx) { super(ctx, "pluginInventory") }    // :93
async list() {
  for (const entry of this.ctx.loader.entries()) {
    if (entry.options.group) continue                                    // :111
    entries.push({ entryId, moduleName: entry.options.name,
                   enabled: !entry.disabled,
                   fiberPhase: FIBER_PHASE[entry.fiber?.state] })       // :112-117
  }
  // 有 agentPresets 時另外附上每個 preset 的 composition rows        // :119-130
}
```

- 服務名 **`pluginInventory`**；需要 `loader` 服務
- **免子進程、免讀檔**，直接是 loader 的唯讀投影
- `fiberPhase` ∈ `pending | loading | active | failed | null | unloading`

> **對 R2 的意義**：面板要顯示「已載入的 entry 與真實啟用狀態」時，
> 這是官方唯讀通道，比自己讀檔準（尤其 `!!js` 的 `disabled` 它已經求值過）。
> **但**它只反映**當前進程已載入的樹**，看不到「磁碟上有什麼還沒載入」——
> 那一半仍要靠 V1/V2 讀檔。**兩者互補，不可取代。**

⚠️ `[測]` 本機 `cordis.yml` 只有 223 B，**沒有出現 `plugin-inventory` 這一列**
（grep 零命中）。所以它在本 profile 是否真的被掛上，**待辦 T4**。
**不要假設 `ctx.get('pluginInventory')` 一定拿得到。**

### F3 ⛔ `--dump-config` 不做任何模組解析（本文件最重要的一條）

`[測]` 用 `--patch` 插入一條指向不存在套件的 row：

```yaml
- insert:
    - id: probe-nonexistent
      name: 'dsh-probe-does-not-exist-xyz'
```

```powershell
& node <checkout>/dsh/lib/bin.js --profile web --patch <ov> --dump-config
# exit=0  stdout=17,793 B
```

那個 row **原樣出現在輸出裡**：

```
# == <overlay 的絕對路徑>
- id: probe-nonexistent
  name: dsh-probe-does-not-exist-xyz
```

> ⛔ **「裝之前會不會爆」不能只靠 V1。**
> V1（離線 compose）與 V2（模組解析）**兩層都必須做，且不能互相取代**：
>
> | 層 | 抓得到 | 抓不到 |
> |---|---|---|
> | **V1** compose | YAML 壞、overlay 讀不到、bundle 未裝、bundle 無 `dsh.bundle` | **任何指向不存在套件的 row**、`!!js` 真值、import 期失敗 |
> | **V2** 模組解析 | row 引用 `node_modules` 裡不存在的套件、lock 與實裝漂移 | 套件在但 export 壞、`apply()` 期失敗 |
>
> 沒有 V2，本插件的核心承諾有一半是空的。

### F4 四階段的錯誤簽名（`doctor` 的簽名清單來源）

`[碼]` 宿主在四個階段以不同方式失敗。**分清楚這四階是整個 verify 設計的基礎。**

| 階段 | 簽名 | 位置 | V1 看得到？ |
|---|---|---|---|
| **Compose** | `failed to read overlay <file>: ...` | `:1165` | ✅ |
| **Compose** | `failed to parse overlay <file>: ...` | `:1197` | ✅ `[測]` |
| **Compose** | `failed to parse config <file>: ...` | `:1247` | ✅ |
| **Compose** | `cannot resolve profile bundle "X" from the dsh installation or <dir>; run 'dsh plugin --profile <n> install' ...` | `:831` | ✅ |
| **Compose** | `profile bundle "X" declares no dsh.bundle in its package.json` | `:852` | ✅ |
| **Settle 後** | `plugin(s) failed to load: <names>; Cordis startup failed ...` | `:1438` | ❌ |
| **進程級** | `dsh: fatal load failure: <stack>` → `exit(1)` | `:1407` | ❌ |

### F5 來源種類在磁碟上的長相——決定快照要記什麼

`[測]` 以一個 tarball URL 來源的社群套件為例：

| 位置 | 內容 |
|---|---|
| profile `package.json` 的 spec | `https://github.com/<owner>/<repo>/releases/latest/download/<name>.tgz` |
| `pnpm-lock.yaml` importers 段 `specifier` / `version` | **兩者都是完整 URL**，不是版本號 |
| `pnpm-lock.yaml` packages 段 | `resolution: {integrity: sha512-…, tarball: <URL>}` ＋ **`version: 0.3.3`** |
| `node_modules/<name>/package.json` | **`version: 0.3.3`** |

> **兩個可直接用的結論**：
> 1. **實裝版本只能從 `node_modules/<n>/package.json` 的 `version` 讀**——
>    lockfile 的 importer 段在 URL 來源下記的是 URL，不是版本。
> 2. **`integrity` 才是「同一個 spec 有沒有換內容」的指紋**——
>    `releases/latest/…` 這種 URL 的 spec 永遠不變，但內容會變。
>    只要 `integrity` 變了就是換版。
>
> ⇒ 快照**不能只記 spec**。要記：`version`、`integrity`、`resolvedDir`、
> bundle patch 的 `patchSha256`，以及 dump 全文。

### F6 profile 佈局的實測

`[測]` `$DSH_HOME/profiles/web/`：

```
package.json          # name / private / dependencies / dsh.profile.bundles
cordis.yml            # 223 B，profile 的 root 配置
pnpm-lock.yaml        # 49,285 B
pnpm-workspace.yaml
node_modules/
.dsh-module-fallback/
cordis.patch.yml.bak                  # 使用者自己的備份
cordis.patch.yml.bak-plugin-manager   # ← 別的插件留下的備份
```

**注意**：`cordis.patch.yml` **本身不存在**——使用者沒有自己的圖層（R6 說的那個檔）。
它的 `.bak` 存在只說明「曾經有過」。

`[碼]` `dsh-app-boot/lib/index.js:861-862`：user layer 是
`join(dir, PROFILE_PATCH_FILENAME)`，**只有檔案存在時才讀**，不存在就是空陣列。

> ⇒ **R6「不寫使用者的 `cordis.patch.yml`」在實作上等於「不要無中生有這個檔」。**
> 而 `cordis.patch.yml.bak-plugin-manager` 這個檔名說明：
> 已有插件在用「同目錄 `.bak-<插件名>`」的慣例。本插件若也用備份，
> **要選不會撞名的命名，且不該是單份會覆蓋的那種**（見下節反面教材）。

### F7 ⛔ 宿主半拿不到 `node:fs` 與 `node:child_process`

`[測]` 查執行中宿主的 Builtin 目錄，一個宿主半可用的符號**只有**：

```
ctx, harness, console, btoa, atob, TextEncoder, TextDecoder
```

**沒有 `require`、沒有 `import`、沒有 `process` 保證、沒有 timers。**
⇒ 宿主半**既不能讀檔、也不能 spawn 任何東西**。

**但宿主服務可以**——同一份服務目錄裡有：

| 服務 | 關鍵方法 | 對本插件的意義 |
|---|---|---|
| **`clientModules`** | `graph(): WebBootGraph` | 直接回**全部 web 插件 entry**：`{id, url, rev, inject?, immediately?, external?}` ＋ `batches`。**免子進程、免讀檔、免沙盒** |
| `fs` | `resolve` / `readText` / `writeText` / `editText` / `listDir` | 檔案存取，**走沙盒政策**（不是 raw `node:fs`） |
| `subprocess` | `resolveExecutable` / `spawn` | spawn 走宿主服務與政策（不是 raw `node:child_process`） |
| `shell` | `run` / `start` | shell 執行 |
| `jobs` | `start` / `read` / `wait` / `kill` | 背景任務生命週期 |
| `webServer` | `register` | HTTP 路由（R2 唯一允許的） |

> **⇒ 這改變了 A3 的問題形式。** 原本問「插件能不能 spawn `dsh`」，
> 現在要問「**該不該** spawn」。`clientModules.graph()` 給了大部分本來要靠
> `--dump-config` 才能拿到的東西，而且沒有子進程、沒有 122 ms、沒有沙盒問題。
>
> **新的分工建議**：
> - **讀「現在裝了什麼、載入了什麼」** → `clientModules`（首選）
> - **讀 profile 磁碟狀態** → `fs` 服務（走沙盒）
> - **跑 `--dump-config` 離線 compose 預檢** → 只剩這條真的需要 `subprocess`，
>   且應該用 `subprocess` ＋ `jobs` 服務，**不是** raw `node:child_process`
>
> ⬜ T2 仍未完成：**尚未實測** `subprocess` 服務在宿主半內可用且不卡死。
> 但阻塞程度降低——M1 的唯讀面板完全不需要它。

### F8 ⛔ `pluginInventory` 在真實部署裡**沒有被註冊**

`[測]` 兩條獨立證據：

1. `cordis.yml`（223 B）grep `plugin-inventory` **零命中**
2. 查執行中宿主的 Service 目錄：`pluginInventory` **不存在**
   （`clientModules` 存在且可用）

⇒ **不能假設 `ctx.get('pluginInventory')` 拿得到。** 服務本身由
`@deepseek-ai/dsh-host-plugin-inventory` 提供、套件也裝了，
但這個部署沒有把它掛進組合樹。
**程式碼必須把 `undefined` 當成正常情況處理，不是例外。**

> ⇒ 面板的資料來源應以 **`clientModules` 為主**，`pluginInventory` 為選用補充。
> `plan.md` §5.2 提到它時必須加這條警語。

### F9 `settings.plugins.tab` 是活的，且已有兩個占用者

`[測]` 查執行中 client 的 slot 樹：

| 事實 | 值 |
|---|---|
| slot key | `settings.plugins.tab`（`kind: list`、`scope: root`、`replaceRisk: none`） |
| 註冊選項 | `id`（必填）／`order`（可選）／`label`（可選，`string \| () => string`） |
| 既有占用者 | `configurable`（order 0）、`all`（order 10） |
| 子 slot | `settings.plugin.item`（`kind: keyed`，目前無人占用） |
| owner props | 空（`children?: never`） |

`label` 可以是 thunk，**每次投影重讀** ⇒ 本地化文字跟著 locale 走，不必重新註冊。

> ⇒ **新 id ＋ order 15 就會出現在兩個既有分頁旁邊，不會取代任何人。**
> 子 slot `settings.plugin.item` 是「每個插件一張卡」的座位——**未來的詳細頁
> 應該用它，而不是自己做一張大表**。

**Client 端可注入的服務**（同名目錄）：`slots`、`locale`、`theme`、`layout`、
`timer`、`sessions`、`workspaces`、`uiWorkspace`。
**Client builtin**：`ctx`、`React`（無 JSX 轉換）、`host`（套件私有 RPC）、
`styles`（插入 CSS 並隨生命週期清掉）、`console`。

### F10 瀏覽器半的掛載契約（`[碼]`）——**這一節決定 client 半怎麼寫**

`client-modules` 掃描 **host loader 的 entry**，凡是套件宣告 `dsh.client` 的，
就去找它的 client bundle。三件事缺一不可，**缺任何一件都會讓整個 web boot 大聲失敗**
（`FAILED` fiber，開機稽核會報）。

**① 套件必須宣告 `dsh.client`，且 `exports["./client"]` 必須指向一個已存在的檔案**

```json
"exports": { ".": "./src/host/index.js", "./client": "./src/client/client.js" },
"dsh": { "bundle": { "patch": "./cordis.patch.yml" },
         "client": { "platform": "web" } }
```

`[碼]` `dsh-client-modules/lib/index.js:649-659`：

```js
const decl = parseDshClient(packageName, dsh.client)
const clientRel = clientExportOf(packageName, pkg.exports)
if (clientRel === void 0) throw new Error(`client-modules: ${packageName} declares dsh.client but exports no "./client" bundle`)
```

⇒ **bundle 必須是「已建置好的單一檔案」。** 宿主不會替你打包，
而且 **bundle 內部的相對 `require` 也解不掉**——見 F15。這是很硬的約束，
不是風格問題。本插件因此有一個**必要的**建置步驟：
`npm run build:client` 把 `src/client/*.js` 折成單一 `src/client/client.js`。

**② bundle 必須是 `window.__ModuleLoader__.load({id, factory})` 的形式**

`[碼]` 真實 shipped bundle 的形狀（`dsh-client-ui-settings-plugin-inventory/lib/client.js:1-6`）：

```js
window.__ModuleLoader__.load({
  id: "@deepseek-ai/dsh-client-ui-settings-plugin-inventory",
  factory: (require) => {
    var module = { exports: {} }
    var exports = module.exports
    let react = require("react")
    // … 定義元件與 apply …
    exports.apply = apply
    exports.inject = inject
    return module.exports
  }
})
```

**③ factory 的 exports 必須有 `apply`（cordis plugin 函式），可選 `inject`**

`[碼]` 同上，`:676-679`。`exports.apply` 就是一個收 client context 的 cordis plugin。

**graph entry 的 id ＝ 套件的 `entry.options.name`**（`[碼]` `:802,826`
`graphRow(packageName, rev, source.meta)`；`:654` 的 `packageName` 來自
`resolveSource`）。而 `clientPath(id)`／`invariant.js:24` 是用 **`row.id`** 查表。

> ⚠️ **由此得出一條容易炸的規則**：
> `package.json` 的 `name` 與 bundle 的 `id` 必須一致，**且 patch 行的 row id
> 不能等於套件名**。否則 `resolveSource` 會在同一個套件名底下解到兩個 loader
> entry 而 throw：
>
> ```
> client-modules: package X resolves from multiple active Loader sources: …; remove one entry
> ```
>
> 本插件因此：package name ＝ `dsh-plugin-manager`、bundle id ＝ `dsh-plugin-manager`、
> **patch row id ＝ `plugin-manager`（刻意不同）**。

**④ 誰依賴誰：`dsh.client.inject` ≠ Cordis `inject`**

- 套件層 `dsh.client.inject`：**其他套件名**，宣告「我的 bundle 依賴誰的 bundle」，
  由 loader 負責先送達（`[碼]` `:265-268`）
- bundle 的 `exports.inject`：**cordis 服務名**（本插件用 `['slots']`）
- factory 的 `require(name)`：**只拿得到** core 模組（`react` 等）與**同套件**
  相對路徑。任何其他套件名都要先在 `dsh.client.inject` 排隊，否則執行期直接 throw
  （`[碼]` `:401`）

> ⇒ **本插件只 `require('react')` 與自己的相對檔**，所以 `dsh.client.inject` 留空，
> 少一整類開機失敗。

**⑤ bundle 內容改了就換 rev——但只有一個入口會重新雜湊**

`[碼]` `:538-550` `rebuilt(id)`：「the only entry point through which bundle content
changes reach the graph」，由 HMR watch 呼叫。⇒ 改 `src/client/*` 之後，
`rev` 會不會更新取決於 HMR 有沒有在跑。**要看到新 UI，最保險是重啟 `dsh web`。**

### F11 ⛔ 動態 Cordis 外掛的執行環境與真插件不同

`[測]`（實戰學到的，不是讀來的）。這一節只在用動態外掛做原型時適用。

| | 真插件（`dsh.bundle` 路線） | 動態 Cordis 外掛 |
|---|---|---|
| client 半 | 要自己寫 `window.__ModuleLoader__.load({id, factory})` 外殼 | **不用**；直接 `return { apply(ctx) {...} }` |
| 可用符號 | 任何 `exports["./client"]` 打包進去的東西 | **只有 builtin**：client 端 `ctx` / `React` / `host` / `styles` / `console`；host 端 `ctx` / `harness` / `console` / `btoa` / `atob` / `TextEncoder` / `TextDecoder` |
| module scope | 一般 ESM | **沒有 module scope 的概念**——整個 body 是函式本體，所有「頂層」宣告都算在函式內 |
| 壽命 | 跟著 `dsh web` 重啟存活 | **行程結束就消失**，要重新 define ＋ run |

**`styles.insert(css)` 的契約**（`[碼]` `dsh-cordis-client-runner/lib/client.js:84-85`）：

```js
insert(css) {
  if (typeof css !== "string") throw new Error("styles.insert(css) needs a CSS string");
```

⇒ **`css` 必須是字串，其他一律 throw**（`undefined`、`null`、陣列都算）。
而這個 throw 發生在 `apply()` 裡，所以症狀是「整個 client 半 evaluate 失敗」

```
evaluate: failed to apply loader entry <id>: styles.insert(css) needs a CSS string
```

**⚠️ 踩過的坑（值得記下來）**：把 repo 的 `src/client/*` 改寫成動態外掛的單一函式體時，
**漏掉了 `const CSS = ...`**，但保留了 `styles.insert(CSS)`。因為動態外掛沒有
module scope，`CSS` 就是一個未宣告的識別字——**錯誤訊息不會說「CSS is not defined」，
只會說「needs a CSS string」**，所以症狀看起來像 API 用錯，實際上是自己的疏失。

⇒ **教訓**：被問到「這個 API 要什麼」時，先確認**自己傳的是什麼**。
不能因為錯誤訊息指向 API 就假設 API 有問題。

**動態外掛的正規做法**（`[碼]` skill `cordis-plugin-development`）：

- `styles.insert(css)` ＋ **顏色一律走主題 CSS 變數**，不要硬編碼
- UI 一律註冊在**查過的 slot** 裡；`apply()` 不可以直接回 React element
- timer 是**服務**不是 builtin：要 `inject: ['timer']` 再用 `ctx.timeout/interval`，
  **不准用全域 `setTimeout`**
- 每個副作用都要有 disposer（`ctx.effect`）

### F12 動態外掛的授權是**逐 Package**的

`[測]`：`pkg-1` 批准過、執行失敗後，定義 `pkg-2` 並啟動**仍要再批准一次**（`run-2`）。

⇒ 單一勾＝只授權那個 Package；雙勾＝授權同一 Plugin 的未來版本。
**做原型時如果預期會改很多版，一開始就該用雙勾**，否則每次修都要等人按。

**但沒有 client 半的 Package 不用批准**：`pmdiag-2` 只改宿半端，`run` 直接回 `running`。

### F13 ⛔ 動態外掛沒有 module scope（`[測]`，踩了三次）

**這是最容易連續踩的坑。** `code.host` / `code.client` 的整段 body **就是一個函式本體**，
所以：

| 直覺 | 實際 |
|---|---|
| 「頂層宣告」是 module scope | 是**函式內的宣告**，`apply(ctx)` 的 `ctx` **不會**自動可見 |
| 可以在外層函式參考 `ctx` | ❌ `ReferenceError: ctx is not defined`（症狀發生在**執行期**，不是定義期） |
| 少寫一個 `const` 會編譯錯 | ❌ 不會；它是一個未宣告的識別字，**錯誤訊息會誤導你** |

**真實案例（兩次都發生在這一輪）**：

1. `styles.insert(CSS)` 而 `CSS` 沒被帶進提交的原始碼 →
   錯誤是 `styles.insert(css) needs a CSS string`，
   **看起來像 API 用錯，實際上是我漏了宣告**（F11）
2. `execute()` 呼叫 `overview()`，而 `overview()` 在外層讀 `ctx` →
   錯誤是 `ctx is not defined`
   ⇒ 正解：**把 `ctx` 當參數傳進去**，不要靠外層捕捉

> **⇒ 規則：在動態外掛裡，任何需要 `ctx` 的輔助函式都要明寫 `ctx` 參數。**
> 定義成功不等於執行成功——`cordis_define` 只做語法檢查，
> 這種錯誤只會在**按下工具或 client 半 evaluate 時**才爆。

**真實事故（本專案第一次跑起來時踩到，值得完整記下來）**

第一版面板的宿主半寫成：

```js
function buildOverview() {                            // ← 沒有參數
  const clientModules = ctx.get('clientModules')      // ← 自由變數
  // …
}
return {
  apply: function (ctx) {                             // ← ctx 只活在這裡
    ctx.effect(function () {
      return harness.handle('overview', function () { return buildOverview() })
    }, '…')
  },
}
```

| 階段 | 結果 |
|---|---|
| `cordis_define` | ✅ **成功**（純語法檢查） |
| approve ＋ client 半 evaluate | ✅ 成功；分頁註冊進 slot 樹（`active: true`） |
| 使用者打開面板 → client 呼叫 `host.call('overview')` | ❌ `ReferenceError: ctx is not defined` |
| 症狀 | **面板整個消失**——資料流一次都沒成功過 |

> **⇒ 兩個推論：**
>
> 1. **「分頁出現」不等於「面板能用」。** slot 註冊只證明 `apply()` 跑完，
>    不證明 RPC 會成功。**驗收必須涵蓋一次成功的資料往返**，
>    不能只看分頁在不在。
> 2. 修法是把服務讀取**綁在 `apply` 內**再當參數往下傳：
>    `const get = (name) => ctx.get(name)` → `buildOverview(get)`。
>    這也正是 `src/host/overview.js` 的形狀（收 `get` 回呼），
>    並由 `test/overview.test.mjs` 的「no free variables」案例強制。

### F15 ⛔ client bundle 必須是**單檔 classic script**——兩個坑

`[測]` 真插件裝進 profile 後連續撞了兩次，動態外掛**兩個都照不出來**。

#### 坑一：bundle 內的相對 `require` 解不掉

```
Failed to load plugins
failed to import loader entry f5e1d8bf (dsh-plugin-manager):
client-modules: require("./panel.js") missed the module table — not a platform
seed word, not a materialized module, and no registered package factory
(a build-time externals drift, or a dynamic dependency that did not arrive)
```

`[碼]` 成因在 `dsh-client-modules/lib/client.js:300-309`：

```js
makeRequire(edges) {
  return (spec) => {
    if (this.seed.has(spec)) return this.seed.get(spec)       // ① 平台種子字
    const id = stripClientSuffix(spec)
    if (this.loadCache.has(id)) return record.exports          // ② 已載入
    if (this.factories.has(id)) return this.materialize(id).exports  // ③ 已註冊套件
    throw new Error(`client-modules: require("${spec}") missed the module table …`)
  }
}
```

**只有三條路，`./panel.js` 一條都不符合。** `stripClientSuffix` 只處理尾綴 `/client`。

| 路 | 是什麼 | 本插件用不用 |
|---|---|---|
| ① seed | 平台提供的字（`react` 等） | ✅ 只用 `react` |
| ② 已載入 | 同一頁已 materialize 的模組 | ❌ |
| ③ 已註冊套件 | boot graph 裡的其他套件（需 `dsh.client.inject` 宣告） | ❌ 刻意不用 |

#### 坑二：bundle 必須是 **classic script**，不能留 `export`

修好坑一之後的錯誤，而且**症狀完全不同**——它攻擊的是**鄰居**：

```
failed to import loader entry fb16b19e (@deepseek-ai/dsh-client-hmr):
client-modules: bundle /plugins/??…,dsh-plugin-manager/client.js,…&rev=… loaded
without registering "@deepseek-ai/dsh-client-hmr" via __ModuleLoader__.load
```

注意 combo URL 裡**有我們**（`…,dsh-power/client.js,dsh-plugin-manager/client.js,…`）。
combo 是**一整包 script**，任何一個 bundle 有語法錯誤就整包不執行——
於是排在我們後面、還沒註冊的 `dsh-client-hmr` 就永遠註冊不了。
**錯誤訊息指向受害者，不是兇手。**

我的建置腳本第一版只把原始碼縮排＋包起來，**沒把 `export` 拿掉**。產物裡留著
`export const CSS = …` ⇒ classic script 語法錯誤。

**而 `export const zh = {` 這種多行宣告讓修法變得不直覺**：
原本想在宣告後面補一行 `exports.zh = zh`，但那是**逐行**轉換，
會把賦值插進多行物件字面量的**大括號裡面**：

```js
const zh = {
exports.zh = zh        // ← 插在這裡，語法就爛了
  tab: '插件管理器',
```

> **⇒ 正解：`export` 直接刪掉就好，不要補 `exports.X = X`。**
> 每個模組都在自己的 factory 裡，`export` 拿掉後宣告仍在 scope，
> factory 最後 `return { … }` 把名字交出來即可。**不需要 `exports` 物件。**

#### 為什麼動態外掛兩個坑都照不出來

動態外掛的 client 半由 evaluator 直接持有整個函式本體——
**既沒有 `require`，也不經 classic-script 載入**。
所以同一份設計在動態外掛上完全正常，換成真插件就連環爆。
**這是原型與真插件之間最貴的差異。**

#### 本專案的處理

- `src/client/{copy,styles,face,panel}.js` 是原始碼，**互相不 import**（只有 `export`）
- `build-client.mjs`：拿掉 `export` → 包成 factory → factory 回傳 exported 名字
- `bundle.json` 保存要折的清單，**建置腳本與測試共用同一份**，不會漂移
- 產物開頭有 `GENERATED` 標頭；`npm test` 第一道是 `build-client.mjs --check`，
  **過期就 fail**（過期 ＝ 下一次開機失敗）
- **`test/bundle-exec.test.mjs` 是真的去執行產物**：stub 掉
  `window.__ModuleLoader__`、用 `new Function` 以 classic script 方式編譯、
  呼叫 `factory(require)`、再真的呼叫 `apply(ctx)`
  ⇒ **坑一與坑二都會被它抓到。** 這比任何靜態檢查都有價值——
  兩個坑都不是「讀程式碼看得出來」的，是「跑起來才爆」的
- `test/bundle.test.mjs` 靜態斷言：bundle 內**只能有 `react` 一個 require**

### F16 ⛔⛔ 動態外掛的 builtin **不是**真插件的 API（架構級誤解）

`[測]` 這是最貴的一條。真插件第一次成功載入後，兩半各給了一個明確的錯誤：

```
[dsh-plugin-manager] harness.handle is unavailable; the panel will have no data channel
…
failed to apply loader entry b90283df (dsh-plugin-manager): styles is not defined
```

#### `styles` / `host` / `harness` 全都是 **dynamic-plugin 沙盒專屬**

`Builtin.listBuiltins` 那份清單，說明欄自己寫著 **"available to a dynamic Host half"** /
**"dynamic Client half"**——那是**動態 Cordis 外掛**的環境，不是真插件的。

| 我以為 | 實際 |
|---|---|
| client bundle 拿得到 `styles` | ❌ 只有 dynamic Client half 有 |
| client bundle 拿得到 `host.call` | ❌ 同上 |
| host `apply(ctx)` 收第二個參數 `harness` | ❌ 真插件只收 `ctx` |
| `Builtin.listBuiltins` 列的是平台 API | ❌ 它列的是**沙盒**注入的符號 |

`[碼]` 真 bundle 的 factory **只收 `require`**，而既有實作全部長這樣：

```js
factory: (require) => {
  var module = { exports: {} }
  var exports = module.exports
  let react = require('react')
  …
  exports.apply = apply
  exports.inject = inject
  return module.exports
}
```

#### 真插件實際用的 API（`[碼]`，從 shipped bundle 讀出來）

```js
// client 半
const inject = ['slots', 'locale', 'remote', 'remote.pluginInventory']
function apply(ctx) {
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), '…')   // 用 ctx.locale，不是 ctx.get
  const result = await ctx.remote.pluginInventory.list()        // client→host 的正規通道
  ctx.slots.inject('settings.plugins.tab', () => ctx.slots.register({ … }, Panel))
}
```

- **宣告在 `inject` 裡的服務直接掛在 `ctx` 上**，不是 `ctx.get` 之後再檢查
- **`ctx.remote.<namespace>`** 是 client→host 的正規通道；背後是 typert 產生的 Remote 閘道，
  需要宿主半有對應的 Remote 服務
- **CSS 沒有服務**：真 bundle 的 CSS 由建置工具處理。自行插入 `<style>` 是唯一
  零建置依賴的做法

#### 本插件選的通道

`ctx.remote` 需要 typert 註冊與產生的型別，對一個獨立插件太重。改成
**`webServer` 路由 ＋ `fetch`**——正是
`@linxin666/dsh-client-ui-plugin-manager` 在沒有官方安裝器服務的 runtime 上的做法：

```
host  : ctx.effect(() => ctx.webServer.register({ kind:'exact', path:'/api/dsh-plugin-manager/overview', handler }))
client: await fetch('/api/dsh-plugin-manager/overview').then(r => r.json())
```

路徑契約放 `src/endpoints.json`；宿主半**刻意把前綴寫成字面值**（啟動時不讀檔 ＝ R1），
由 `test/host-routes.test.mjs` 斷言兩者相等。

> **⇒ 最重要的一條教訓：**
> **`cordis_inspect_query` 的 Builtin 目錄描述的是「當前動態外掛的環境」，不是「平台 API」。**
> 用它設計**原型**沒問題；把原型當**產品**就會整個架構錯掉。
> 真插件的 API 只能從 **shipped bundle 的原始碼**讀出來。

#### 為什麼測試沒抓到（已修）

`test/bundle-exec.test.mjs` 原本把 `styles`、`host`、`console` 當**參數**注入沙盒——
那正好模擬了動態外掛的環境，於是 bug 完全隱形。
現在它**只注入瀏覽器本來就有的東西**（`window`、`document`、`fetch`、`console`），
並追加兩個案例：不帶 `fetch` 時 `apply` 仍不拋，以及原始碼不得出現
`styles.insert` / `host.call` / `harness.*` 的**用法**。

### F17 ⛔⛔ 定位 profile 目錄：**`fs.resolve('.')` 就是答案**

`[測]` 這一輪的症狀是「面板列出 0 筆非原裝插件」，而真正的問題是
**我分不出「真的沒裝」與「讀不到 profile」**——兩者在我的程式碼裡長得一樣。

#### 錯誤的路：用 `clientModules.clientPath()` 反推

`[測]` 直覺是拿自己的 client bundle 路徑往上走。**它行不通**：

```
clientPath('dsh-plugin-manager')
→ C:\Users\<user>\Documents\code\git\dsh-plugin-manager\src\client\client.js
```

`link:` 安裝經過 junction，而 **`clientPath` 回的是解析後的真實路徑**，
所以往上走只到 `C:\Users`，永遠碰不到 profile。

#### 正確的路：**fs 服務的基準目錄就是 profile 目錄**

`[測]` 宿主行程的 cwd 就是 profile 目錄（`dsh web` 是在那裡被啟動的）：

```
fs.resolve('.')             → C:\Users\<user>\.dsh\profiles\web
fs.resolve('package.json')  → 讀得到，935 字元，dependencies 完整
fs.resolve('..')            → C:\Users\<user>\.dsh\profiles
fs.resolve('node_modules')  → …\profiles\web\node_modules
```

> **⇒ `fs.resolve('.')` ＋ `join(base, 'package.json')` 就拿到 profile manifest，
> 完全不需要任何環境變數。**
>
> 這很重要，因為**宿主半可能沒有可用的 `process`**（見 F18）。
> 環境變數（`DSH_HOME` / `DSH_PROFILE`）只留作退路，
> 而且每個候選與每次嘗試都要**記錄下來**。

#### 附帶回答：`fs` 服務讀得到工作區外的檔案

`[測]` 沙盒不會擋掉 `~/.dsh`：

```
readText(C:\Users\<user>\.dsh\profiles\web\package.json)  → ok, 935 chars
readText(<repo>\package.json)                              → ok, 855 chars
resolve(C:\Users\<user>\.dsh\settings.yaml\undefined)      → FS_NOT_FOUND
```

⇒ **`fs` 是 `webServer` 之外第二個實用依賴**，而且不必放寬任何政策。
它是**選用**讀取（`ctx.get('fs')`），失敗就降級成可讀的 notice。

### F18 ⚠️ 動態沙盒 vs 真插件的全域差異（對照表）

`[測]` 兩邊都實測過。差異會直接造成「原型能跑、產品不能跑」：

| | 動態 Cordis 外掛沙盒 | 真插件（`dsh.bundle`） |
|---|---|---|
| `process` | ❌ **沒有** | 應該有（真宿主行程），但**不可依賴** |
| `process.env` / `argv` | ❌ 拿不到 | 同上 |
| `ctx.get('fs')` | ✅ ok | ✅ ok（已由 `fs.resolve('.')` 證實） |
| `ctx.get('clientModules')` | ✅ ok | ✅ ok |
| `ctx.get('subprocess')` / `shell` / `storage` | ✅ ok | 未測 |
| `styles` / `host` / `harness` | ✅ **只有這裡有** | ❌ 不存在（F16） |
| 壽命 | 行程結束即消失 | 跟隨 profile |

> **⇒ 兩條規則：**
> 1. **不要用環境變數當唯一資訊來源。** 沙盒沒有 `process`，而真插件也不該假設它有。
>    能用服務推導的，就用服務推導。
> 2. **沙盒有的東西不代表產品有，反之亦然。** 判斷「這個 API 存不存在」唯一可靠的方法
>    是讀 **shipped bundle 的原始碼**，不是讀 Inspect 的 Builtin 目錄。

### F19 跨平台：哪些寫法通用、哪些不通用

**已確認通用**（`[碼]` ＋ 測試）：

| 位置 | 做法 | 為什麼通用 |
|---|---|---|
| 定位 profile | `fs.resolve('.')` | **服務層，與平台無關**；這是第一策略 |
| harness home 退路 | `node:os.homedir()` ＋ `join(home, '.dsh')` | 與宿主自己的 `dsh-home-paths` 同一個函式 |
| 路徑拼接 | `node:path` 的 `join` | 平台正確的分隔符 |
| 最後退路 | `USERPROFILE`（Windows）**與** `HOME`（POSIX）**都試** | 不是只挑一個 |
| 測試 fixture | `resolve('X:', 'harness', '.dsh')` | 在 Windows 是 `X:\…`、POSIX 是 `/X:/…`，斷言兩邊都成立 |
| 宿主半 import | `node:os` / `node:path` / `node:fs` ＋ 相對路徑 | R1 沒破 |

**曾經不通用、已修**：

| 問題 | 症狀 | 修法 |
|---|---|---|
| `envValue('USERPROFILE') ?? envValue('HOME')` | Windows 偏向；`HOME` 只是順便 | 改成 `os.homedir()` 優先，兩個變數都留作退路 |
| 測試 fixture 用 `join('X:', 'harness')` | 內部自洽所以會過，但那是僥倖不是設計 | 改用 `resolve(...)` 產生絕對路徑 |
| `basename` 風格路徑解析 | 跨分隔符時可能錯 | 自寫 `lastSegment`，同時處理 `/` 與 `\` |

**⚠️ 測試隔離的坑**：`os.homedir()` 讀的是**真實機器**（Windows 看 `USERPROFILE`，
POSIX 看 `HOME`），所以單元測試**沒辦法靠清環境變數隔離它**——真實 home 會混進候選清單。
`setHomedirReader()` 就是為此存在的注入點，**只有測試會用**。

> **誠實聲明：只在 Windows 上實跑過。** macOS / Linux 是靜態推理 ＋ 平台無關的 fixture，
> 沒有實機驗證。

### F33b ⛔⛔ 我從**自己的專案**推廣到所有 checkout——使用者一句話就推翻了

F33 我把版本顯示改成「跟來源走」：registry 顯示版號、本地 checkout 顯示 commit。
理由是我自己的 `package.json` 還停在 scaffold 的 `0.0.0`，
於是我推論「**本地 checkout 的 version 欄位按定義就是過時的**」。

**`[使用者]` 只回了一句就推翻了它**：「等等，dsh-tavern 的版本好像是真的」。

實測：

| repo | `package.json` version | git tags |
|---|---|---|
| dsh-power | **`1.8.0`** | 0 |
| dsh-tavern | **`2.6.72`** | 0 |
| dsh-plugin-manager | `0.0.0` | 0 |

**這兩個 repo 的版號有人在維護，而且他們完全不用 git tag。**
所以「有 git repo ⇒ version 過時」是錯的。我犯的是**取樣偏誤**：
把自己一個專案的狀態當成通則，而**證據就在同一台機器上，我沒去看**。

#### 修法：一個訊號，所有來源

`package.json` 的 version 就是版本，**不分來源**。使用者的理由也更強：

> 「v0.2.1 這樣顯示才比較直觀，並且其他也兼容，所以我認為我們應該兼容他們。」

`v0.2.1` 是讀者已經知道的格式；**一個訊號勝過兩個需要規則才能分辨的訊號**。

commit 沒有被刪掉——它仍然在摺疊區，因為它回答的是**另一個問題**：
「跑著的這份 build 是哪一份」，而那正是改本地 checkout 的人會問的。

#### 順手做的事：把自己那顆的版號補上

`0.0.0` 是 scaffold 佔位，不是版本。而我原本的推論之所以「成立」，
正是因為**我沒有維護它**——那不是「checkout 的性質」，是**我的疏漏**。
已 bump 成 `0.1.0`（`private: true`，本來就不發佈，所以「發佈才 bump」不適用）。

#### 教訓

> **在斷言一整類東西的性質之前，先把那一類量過一輪。**
> 我手上有三個 checkout，只讀了自己那一個就下結論。
> 三個檔案讀完不用一分鐘——**省下的卻是我兩輪來回的時間**。

### F33 ⛔⛔ `v0.0.0` 是**技術上正確、實質上是謊**——版本訊號取決於來源

`[使用者]` 問：「dsh-plugin-manager，他是怎樣檢測版本的？」

實測三個訊號：

| 訊號 | 值 | 意義 |
|---|---|---|
| `package.json` version | **`0.0.0`** | scaffold 填的，**從那次之後沒動過** |
| git commit | `ef5d61a1` | **真正的版本**——每個 commit 都在改它 |
| lockfile | `link:../../..` 路徑 | **沒有版本**（F26 已發現） |

#### 為什麼會這樣

我一開始是照「**npm 套件**」去想：registry 的 spec 解析出一個真實版本，
所以 `package.json` 的 version 就是答案。**對 registry 是對的，對本地 checkout 是錯的。**

一個 `link:` 安裝指向一份**正在被編輯的工作區**，它的 version 欄位
**按定義就是過時的**——沒人會每改一行就 bump 一次。所以面板顯示 `v0.0.0`
不是讀錯，是**讀了一個對這個情境沒有意義的欄位**。

⇒ 版本訊號必須**跟著來源走**：

```
registry / tarball  →  package.json version   （真實版本）
link / workspace    →  git commit            （識別碼）
```

`git commit` 由宿主讀 `.git/HEAD` ＋ 一個 ref（F26：`git` 不在 PATH 上），
**只讀兩三個小檔案、不走路徑樹**——所以它放在 **overview**，不是偵測報告：

> 讓正確的版本**等使用者按按鈕才出現**，是自己製造的謎團：
> 「為什麼我還沒按檢查之前它都寫 v0.0.0？」

#### 順手抓到的空隙

`pathIsLink` **偵測報告有、overview 沒有**。我第一版把版本判斷寫成
`commit !== null && plugin.pathIsLink === true`，而 overview 根本不產這個欄位
→ 條件永遠不成立 → 實測仍然顯示 `v0.0.0`。
修法：commit 讀得到就已經證明是 checkout，**拿掉那個多餘的第二條件**。

#### 自我列在第一位的理由

`[使用者]` 說「如果他是需要特別關照的麻煩放在第一位」。

不是虛榮，是**使用頻率**：這顆插件是使用者**用來看清單的工具**，
它的版本、來源、啟用狀態最常被查；而且它最可能是**正在被編輯的 checkout**，
所以「跑著的這份是不是我剛改的那份」，問的次數遠多於任何第三方套件。
左側色條已經標記它特殊，**位置讓答案不必翻找**。

### F32 ⛔ 「config-forms 未載入」——**不是函式庫的問題，是我把它報成了故障**

`[使用者]` 貼出畫面上的四行並問「這是什麼為什麼會這樣」：

```
config-forms
v0.2.1
未載入      ← 暗示壞掉
換版        ← 一個沒有動詞的名詞
```

兩個都是我的問題，而且是**兩個獨立的 bug**。

#### bug 1：`not-loaded` 被套用在「本來就不該載入」的東西上

`config-forms` 是 **profile 的依賴，但沒有 `dsh.bundle`**——它是別的插件用的
**函式庫**，永遠不會進 web boot graph，而且**本來就不該進**。

我原本的規則把「enabled 但不在 graph 裡」一律當成故障：

```js
plugin.loaded ? 'running' : 'not-loaded'   // ← 少了前提
```

於是面板用**警告色**加上**描述壞掉插件的字**，去講一個運作完全正常的套件。
**「未載入」不等於「壞掉」**——差別在於：**它本來該不該載入。**

修正：`declaresBundle === false` 走獨立的 `library` 狀態，中性色、中性字
（「函式庫」）。實測兩者確實分開：

```
library  declaresBundle=false loaded=false state=library
bundle   declaresBundle=true  loaded=false state=not-loaded
```

`stateNotRunning` 的文字也跟著改成「**已啟用但未載入**」——
「未載入」單獨看是中性的，它必須自己說出「這不符合預期」。

#### bug 2：`換版` 是**內部欄位名漏到畫面上**

`<summary>` 用的是 `colChangeSignal`，而那是**摺疊區裡面其中一列**的名字：

```js
h('summary', null, t('colChangeSignal'))   // → 只顯示「換版」
```

摘要應該說明**裡面有什麼**，不是**裡面其中一個欄位叫什麼**。
「換版」是個沒有動詞的名詞，而且它不構成打開摺疊區的理由。
改成 `details`（「詳細資訊」）＋ 有跑過偵測時附上判斷結果。

#### 順手修掉的兩個同義反覆

摺疊區裡有兩列的**標籤和值一模一樣**：

```
本插件: 本插件
非 bundle: 非 bundle
```

讀者從中學不到任何東西。左欄是標籤，右欄就必須是**答案**：
`本插件 → 解析後的路徑`、`非 bundle → 函式庫`。

> 共通點：**三個問題都不是崩潰，而是「畫面在說謊或什麼都沒說」。**
> 沒有例外拋出、沒有測試變紅——**只有看著畫面的人能問出「這是什麼？」**。
> 顯示層的 bug 只有使用者抓得到，所以這類回報的價值就在這裡。

### F31 ⛔ 「固定寬度」是被我自己想出來的問題；而且我的測試放過了一次真回歸

`[使用者]` 回報：「停用按鈕可以完全是 switch，然後在按鈕旁邊直接顯示狀態，
這樣就能夠看起來更加整齊，**因為現在名字長度不一樣所以狀態按鈕位置凌亂**」。
接著補了一句關鍵的：「**不用固定長度也可以做到，放在右邊就好了**」。

#### 我原本要走錯的路

我第一版動手時做的是「**固定寬度的狀態區**」——把狀態與控制項包進一個
`width: 72px` 的容器。使用者直接否掉了，而他是對的：

- **固定寬度會被語系咬到。** 中文「已停用」和英文 `disabled` 寬度差三分之一，
  一個數字不可能同時對兩種語言都好
- **不需要那個數字。** `grid-template-columns:minmax(0,1fr) auto auto`
  就是「左邊吃掉剩下的、右邊兩個按內容排」，對齊是**佈局副產品**，不是魔數

⇒ 我拿一個魔數去解一個不需要魔數的問題。使用者的說法更短也更對。

#### 三個設計決定

| 決定 | 理由 |
|---|---|
| **switch 的視覺狀態 = 這個插件是否啟用** | switch 是**狀態顯示**，旁邊的文字是**動作名稱**。兩者不矛盾：switch 說「現在開著」，文字說「按下去會停用」 |
| **狀態用純文字，不用 chip** | switch 已經承載了顏色。再一個有色的藥丸＝**同一個事實兩個訊號**。文字同時滿足了 `color-not-only`——**是標籤讓顏色可被取代**，不是反過來 |
| **switch 有 `role="switch"` ＋ `aria-checked`** | 一個看起來像開關的東西必須**真的是開關**，否則「開著」對螢幕閱讀器是聽不到的 |

#### 我自己造成的兩個錯

**1. 我又在 CSS 註解裡放了反引號。** `` /* transform, not `left`: … */ ``
直接終止 template literal，bundle 語法錯誤，一次弄紅 8 個測試。
**F30 加的守門測試當場抓到**——加它是對的，因為我立刻又犯了一次。

**2. 我的測試放過了一次真回歸。** 我寫了
`assert.deepEqual(rowClasses, ['pm-lead','pm-switch','pm-state'])`，
然後**故意把 `pm-state` 加回 `pm-lead` 裡面**去驗證它會不會紅——
**它綠的。** `deepEqual` 只看直接子元素，看不到**巢狀的重複**，
而那正是它存在的理由（狀態跟著名字跑）。

修法：加一條**結構性**斷言，而不只是數數量：

```js
assert.equal(findByClass(lead, 'pm-state').length, 0,
  'the status must not sit inside the identity column')
```

再驗一次 → 這次紅在正確的斷言上。

> 這是 F23 的第三次應驗：**「改回去會紅」還不夠，要確認它紅在對的斷言上。**
> 我這次差一點就把一條只會綠的測試當成完成了。

### F30 ⛔ 卡片三次改版，「太厚」回報兩次——**測試從頭到尾量錯了東西**

`[使用者]` 回報兩次：先是「卡厚太好了」，然後「卡片仍然太厚了有三層資訊，
盡量保持在兩層左右」。

三次形狀：

| 版本 | 結構 | 高度 |
|---|---|---|
| v1 | 三個堆疊區塊（名稱 / chips / detail） | ~110px |
| v2 | 兩行（identity / chips） | ~64px |
| v3 | **一行**：identity + state + action，其餘摺疊 | ~31px + 摺疊行 |

#### 為什麼前兩次沒有被測試擋下來

**因為我量的是字級和顏色，而「太厚」指的是「畫面上有幾個橫列」。**
那條斷言從來不存在。這與 F24（層級壓平）是**同一類錯誤的第二次發生**：

> 把主觀的排版抱怨翻譯成可量測的性質時，我兩次都選錯了要量的東西。

F24 我選對了「字級差 ≥4px」；F30 我漏掉了「可見列數」。

⇒ 補上 `test/panel-render.test.mjs` 的
`a plugin card renders exactly ONE row of visible content`：
數 **`PluginCard` 的直接子元素**，跳過 `.pm-disclosure`（摺疊的不算在畫面上）。

**已驗證會紅**：把 chips 那行加回去 →
`a card shows one row, found 2 (pm-row + pm-chips)`。

#### 這次的修法：問「哪些是不同層級，哪些只是更多同類」

- **state chip 留在同一行**——它 12px、名稱 13px，所以讀起來是**第二層級**，
  不必佔第二列
- **來源／spec／換版訊號／`disabledBy` 全部進摺疊**——它們是**查表**，不是層級
- **`disabledBy` 從行內句子移進摺疊**：state chip 已經說了「它關著」，
  「被誰關的」是一次查閱。資訊是**移動**，不是刪除（有測試釘住這點）
- 按鈕改成 `pm-op`：無框、11px、右對齊。仍是**有標籤的真按鈕**，
  所以鍵盤可達，也不依賴 hover 才被發現

#### 順手修掉的兩個自身問題

1. **CSS 註解裡的反引號**——`/* … `flex-wrap` … */` 直接**終止了外層的
   template literal**，bundle 變成語法錯誤，一次弄紅 8 個測試。
   ⇒ `styles.js` 的 CSS 字串裡**不准出現反引號**。
2. **測試輔助函式不一致**：`findCards` 回傳的是**已渲染**的卡片
   （`flat(Infinity)` 多剝了一層），但列數要數的是**直接子元素**，
   所以它回傳 0 列。改成把 `PluginCard` 本身暴露給測試呼叫，
   斷言直接對著真正的元件，而不是對著樹的形狀猜。

> 教訓：**收到主觀感受時，先問那個感受對應到哪個可量測的量。**
> 我花了兩輪才問對；第三次問對了，一次到位。

### F29 ⛔⛔ 寫入路徑：三個 bug 全部只有測試會抓到

`[使用者]` 授權寫入，並要求「不用重啟就生效」。前半做了，後半做不到（F28）。
這裡記的是**做寫入時踩到的三個 bug**——三個都是「程式看起來對、行為錯了」。

#### bug 1：輸出的 row 少了 `- `

```js
// 錯：看起來像 YAML，其實不是 list item
return `  { ${parts.join(', ')} }`
```

YAML 的 list item **就是那個 `-`**。輸出「看起來很合理」，用同一支解析器讀回來是
**0 個 row**。由 `setEnabled` 自己「寫前先證明可解析」的檢查擋下——
這正是那條檢查存在的理由。

#### bug 2：手寫的 flow array 被整批丟掉

```yaml
[ { id: keep-me, name: "@me/keep", disabled: true } ]
```

這是 reference `.bak` 的真實形狀。原本的實作**逐行**處理，一整行 flow array 對它
來說是「一個看不懂的 row」，使用者的設定**靜默消失**。

修法：不要自己拆行，**交給已經寫好的解析器**（它本來就支援兩種風格），
再從解析結果重新渲染。

#### bug 3：`path.join` vs 手寫的 `joinPath` —— 保證 2 直接失效

`detect.js` 有一支手寫的 `joinPath`（用 `/`）。`patch-writer` 一開始用了它，
但 **`fs` 服務解析的是平台路徑**，而 `profile.js` 自己用的是 `node:path.join`。

```js
// 錯：Windows 上指向的是「另一個檔名」
const path = joinPath(profileDir, 'cordis.patch.yml')
```

後果不是寫入失敗——**寫入成功**——而是**讀取失敗**，於是：

```
currentText = null        ← 以為檔案不存在
→ restore() 沒有東西可以還原
→ 「寫入失敗就還原」這條保證，靜默地變成什麼都不做
```

**這是最危險的一種 bug：主路徑正常，只有救援路徑壞掉。**
產品碼本身沒錯（用 `node:path.join` 是對的），是那個**測試替身**一開始沒有如實
反映真實服務——`fakeFs` 的建構子把 `Object.entries([[path, content]])` 變成
`{ 0: [path, content] }`，檔案從來沒進到 map 裡。

> 三個 bug 的共通點：**沒有任何一個會讓主流程報錯。**
> bug 1 的輸出「看起來對」、bug 2 只影響別人的資料、bug 3 只影響失敗時的復原。
> 這也是為什麼 `setEnabled` 的**寫後讀回驗證**不是裝飾——
> 它是唯一能看見 bug 1 的東西。

#### 實測結果（throwaway profile，真實檔案 I/O）

```
create  ok=true action=added   restart=true
toggle  ok=true action=updated before=disabled: true
second  ok=true action=added
final rows: [["dsh-tavern",false],["dsh-power",true]]
```

驗證項目：建立、**切換時是替換而非追加**、第二個 id 不影響第一個、
每次輸出都能被同一支解析器讀回。

#### 寫入的邊界（照實寫在程式與 UI 上）

| 保證 | 怎麼做到 |
|---|---|
| 寫入前**先證明結果可解析** | 記憶體裡建好 → 用讀取路徑同一支解析器驗 → 才落盤 |
| 失敗**還原先前位元組** | 讀回的內容留著；驗證不過就寫回去 |
| **不自行提權** | 不傳 `sandboxPolicy`，讓 `checkedTarget` 用部署預設。profile 在可寫根之外就被拒，並回報 `denied: true` |
| **一定說要重啟** | 回傳 `restartRequired: true`，UI 把「成功」與「要重啟」寫在同一句 |

`patch-writer.test.mjs` 13 個案例，涵蓋上述四項與 13 個 round-trip。

### F28 ⛔⛔ 「停用後不重啟就生效」做不到——`disabled` 是組裝期決定的

`[使用者]` 選擇：允許寫入 patch 檔，並且**希望不用重啟就生效**。

前一半可以做到。後一半**我查完了，做不到**，理由不是「還沒做」而是機制問題：

#### 證據

**1. `disabled` 在組裝期就被吃掉了。** `dsh-base` 檔頭自己寫著：

> Later bundle patches and the user's profile cordis.patch.yml address these rows
> by id, **with the last write winning per row**.

「last write winning」是**組裝時**計算的。組完之後 `disabled` 就只是一個已經被
遵守過的布林，**沒有任何執行期 API 能改變一個已經組完的 row**。

**2. 唯一的模組重載機制是 opt-in 的，而且預設關閉。**

```yaml
# Module reload is opt-in per profile. `patchReload: live` config watching
# uses the launcher's watch-only fallback and does not require this row.
- id: hmr
  name: '@deepseek-ai/cordis-plugin-hmr'
  disabled: true
```

而且它管的是**模組檔案的熱重載**，不是**重新組裝 cordis patch 圖**。
就算啟用它，改 `cordis.patch.yml` 也不會觸發 recompose。

**3. 事件目錄裡沒有任何 reload／recompose 事件。**
（`Event.listEvents` 全表查過：最接近的是 `tools/change`、`skills/change`、
`system-prompt/change`，都是**服務內容**變更，不是組裝變更。）

**4. `clientModules` 的 `onRebuilt`／`onGraphChanged` 只涵蓋 web bundle。**
它們能通知瀏覽器換一份 bundle，但**宿主行程已經 import 過的模組不會因此卸載**。

#### 所以誠實的答案

| 動作 | 要不要重啟 |
|---|---|
| 停用／啟用一個插件（改 patch 檔） | **要**。這是組裝變更 |
| 改 `src/client/*` 並重跑 dev watch | 不用（HMR 推新 bundle） |
| 改 `src/host/*` | **要**（F21） |

**本插件是一個插件。** 宿主死了它也死了；宿主組完了它也只能照著跑。
README 的「限制」一節本來就禁止聲稱「宿主起不來也能用」，這裡是同一個原則：
**不准聲稱「不必重啟就能生效」。**

#### 那要怎麼做才對使用者有用

寫入仍然值得做，只是要**把重啟講在最前面**，而不是當成附註：

1. 寫入前備份 `cordis.patch.yml`
2. 寫入後**重新解析整份檔案驗證**（沿用 `parsePatchEntries`），解析不出來就還原
3. 回報「已寫入，**重啟 `dsh web` 後生效**」，並附上改動前後的那一行

> 這條與 F26 的 `reachability: 'local'` 是同一類決定：
> **做不到的事就寫在畫面上，不要讓使用者自己發現。**
> 使用者能接受「要重啟」，不能接受「你說生效了但其實沒有」。

### F27 ⛔⛔ 啟用/停用：機制清楚了，但**寫入撞到 R6**

`[使用者]` 需求：「我需要知道是否已啟用，我可以啟用停用」。

#### 機制（從真實檔案讀出來的，不是猜的）

DSH 的組裝順序寫在 bundle 自己的檔頭註解裡：

```
profile root（空 []）→ 每個 bundle 的 cordis.patch.yml → 使用者的 cordis.patch.yml
```

**逐 row 覆寫，用 `id` 對應，最後寫入者勝。** 所以使用者的 patch 檔是最高權威。
row 的形狀（來自 reference `.bak`，flow style）：

```yaml
[ { id: web-ui-skill-explorer, name: "@linxin666/dsh-web-all/skill-explorer", disabled: false } ]
```

bundle 內部則是 block style，用 `insert:` 包住約 85 個 row。

#### 三個實測發現

**1. 「已安裝」不等於「已啟用」。** row 可以在**自己的 bundle 裡**就被停用。
`@deepseek-ai/dsh-base` 真的這麼做，而且用的是**運算式**：

```yaml
- id: bash-sandbox
  disabled: !!js process.platform === 'win32'
- id: tool-pwsh
  disabled: !!js process.platform !== 'win32'
```

⇒ 這是**組裝期決定，不是使用者的選擇**。所以 `disabled` 絕不能被壓成布林值——
把 `!!js process.platform === 'win32'` 講成「你停用了它」是說謊。
實測 `dsh-base` 共 **84 個 row、6 個帶 `disabled`**（`hmr` 與 `skill-badge` 是 `true`，
其餘 4 個是運算式）。

**2. 解析器有三個坑，全部是實測才發現的。**

| 坑 | 症狀 | 真相 |
|---|---|---|
| `insert:` 外層的 `disabled` | 以為抓到了，其實是 wrapper 的 | disabled 屬於**子 row**。不攤平就不知道是 `hmr` 還是其餘 83 個 |
| `config: { disabled: false }` | 讀成 row 的旗標 | 那是**插件自己的設定**，不是「這個 row 啟用」。要有縮排基準線才分得開 |
| flow array `[ { … } ]` | 回傳**空陣列** | reference `.bak` 正是這個形狀。回空＝「使用者根本沒有 patch 層」 |

**3. `cordis.patch.yml` 現在不存在，而這是正常的。**

```
cordis.yml                     223 bytes  15:10  ← dsh plugin add 重新生成
cordis.patch.yml.bak           313 bytes  18/09
cordis.patch.yml               （不存在）
```

`dsh plugin add` 重新生成 `cordis.yml` 時不會建立 patch 檔。
⇒ **「檔案不存在」要當成「沒有使用者覆寫」，不是錯誤。**
第一版把它報成 notice，等於告訴使用者 profile 壞了，而其實什麼事都沒有。已修。

#### 為什麼這一版是讀取，不是寫入

**R6：不寫使用者的 `cordis.patch.yml`。** 這是本 repo 自己立的硬規則，
而「可以啟用停用」需要寫入。這個衝突要使用者決定，不能由我默默挑一邊。

所以目前做到的是**判斷**，而判斷本身已經有價值：

| `enabledState` | 意思 | 顯示 |
|---|---|---|
| `running` | 已啟用且在 boot graph 裡 | 綠色 chip |
| `disabled` | 有圖層關掉它，且**說得出是哪一層** | 灰卡 + 標明 `cordis.patch.yml` |
| `not-loaded` | **已啟用卻不在 graph 裡 → 故障，不是選擇** | 警告色 chip |
| `computed` | 旗標是運算式，從來不是誰的決定 | 中性 chip + 顯示原始運算式 |

`not-loaded` 與 `disabled` 的區分是整個功能的價值所在：
把前者顯示成後者，等於告訴使用者「你關掉了一個你根本沒碰過的插件」。

#### 順手修掉的兩個架構錯誤

- **`enabledState` 一度放在 `/detect`，而那條路沒有 boot graph**——結果 8 個插件
  全被報成 `not-loaded`。已移到 `/overview`，那裡才有 graph。
- **找不到 patch 檔被報成錯誤**（見上）。

> 這一節的教訓：**「讀得到」與「寫得動」是兩個獨立的決定。**
> 先做讀取，讓使用者看到真相，再讓他決定要不要交出寫入權。

### F26 ⛔⛔ 「更新偵測」的四個實測限制——`git` 不在 PATH 上

`[使用者]` 需求：「添加一些新的參數讓我能夠線上更新」→ 方向定為
**只偵測、不動手**，參數是「來源、版本號碼」那類。

動手前先量了一件事：**這台機器的 8 個插件到底有幾種來源、各自有什麼可比**。

| 插件 | spec | 可比嗎 |
|---|---|---|
| `@liustack/modsearch`、`config-forms`、`dsh-better-sidebar` | npm 範圍 | ✅ lockfile 有解析後版本 |
| `dsh-plugin-manager`、`dsh-power`、`dsh-tavern` | `link:` → **都是 git repo** | ⚠️ lockfile **無版本**，只能比 commit |
| `dsh-ego-browser` | `file:` → 本機 tgz | ⚠️ 只能比檔案指紋 |
| `dsh-worktable` | github `releases/latest/…tgz` | ⚠️ spec 永遠不變、內容會變 |

#### 限制 1：`git` 不在 PATH 上 → 只能讀 `.git` 檔案

```
Get-Command git → git NOT on PATH
```

所以宿主半**不能 shell out**。改成直接讀 git 的檔案格式：

```
.git/HEAD                      → "ref: refs/heads/main" 或裸 commit（detached）
.git/refs/heads/<branch>       → 本地 commit
.git/packed-refs               → 上面那個檔不存在時的後備（打包過的 ref）
.git/config  [remote "origin"] → url
.git/refs/remotes/origin/<b>   → 上次 fetch 看到的遠端 commit
.git/FETCH_HEAD                → 同上，另一份記錄
```

實測三個 repo 全部讀得出來（branch `main`、remote、commit、tracking ref 一致）。
**這比呼叫 git 更決定性**——不依賴外部執行檔、不受 PATH 影響。

#### 限制 2：`link:` 在 lockfile 裡沒有版本

```
dsh-power:
  specifier: link:C:/…/dsh-power
  version: link:../../../Documents/code/git/dsh-power
```

`version` 是**路徑**，不是版本。所以 `link:` 的比對鍵只能是 commit。

#### 限制 3：「落後遠端」需要 `git fetch`，而這件事做不到

`refs/remotes/origin/<branch>` 與 `FETCH_HEAD` 都是**上次 fetch 時**的快照，
不是現在。本機能證明的只有「本地分支 vs 上次看到的遠端」，**不是**「遠端有新版」。

⇒ 所以 git 的 verdict 只可能是「自上次 fetch 以來有沒有動」，理由字串
**必須寫明 `at last fetch`**。`dsh-power` 剛好是活例子：本地推過 2 個 commit，
tracking ref 跟著更新，**從檔案完全看不出遠端是否有新東西**。

#### 限制 4：`reachability` 決定能宣稱多少

`strategy.reachability` 預設 `'local'`。在這個模式下**沒有任何一條路能說
「有新版可以更新」**，因此：

- 無法比對的來源一律 `unknown`，**絕不** `current`
- 報告最上面有一行 `baseline.note` 直說「no registry was queried and no fetch
  was run, so "a newer version exists" is a claim this report cannot make」
- `params.test.mjs` 用正則**禁止**參數的 label／meaning 出現
  `latest`、`最新版`、`is up to date` 這類字眼——欄位標籤是最容易把
  做不到的宣稱偷渡回來的地方

#### 為什麼不用 `node:crypto`

目錄指紋用**手寫 FNV-1a 32-bit** 疊 `(相對路徑, size, mtime)` 排序後的字串。
理由：不需要任何 import、不依賴 git、跨平台一致。指紋是**變動訊號，不是安全邊界**——
它回答「有沒有動」，永遠不回答「這是不是正版」。截斷時迴報 `truncated: true`，
**不讓半棵樹的雜湊冒充完整結果**。

#### 參數表會腐化，所以用測試釘住

`src/params.js` 宣告 16 個來源參數 + 5 個策略參數，
`test/params.test.mjs` 雙向比對它與 `detect-report.js` 實際吐出的欄位。

已驗證會紅：把 `key: 'commit'` 改成 `commitREMOVED` → 紅在
`params.js declares source parameter "commitREMOVED" but detect-report.js never emits it`。

> 這條規矩是踩出來的：`position` 曾經同時存在於宿主報告與面板渲染，
> 卻不在參數表裡，**沒有任何測試會紅**。手寫的參數清單就是會腐化的清單。

#### 實測結果（本機，真實 8 個插件）

```
lockfileRead=true   counts={"total":8,"current":6,"moved":0,"unknown":2,"hashed":4}
```

`unknown` 的 2 個是 `file:`（無上游）與 `releases/latest` URL（離線不可知）。
4 個目錄指紋全部算出來且未截斷。**這 6 個 `current` 是扎扎實實比對出來的，
另外 2 個誠實承認不知道。**

### F25 ⛔ 「純函式重寫」也會斷掉沒寫下來的契約

`[測]` 症狀：一次改動後**整個測試套件 12 個檔一起紅**，錯誤是

```
TypeError: Cannot read properties of undefined (reading 'length')
    at Module.apply (client.js:918)
```

指向 `apply`，不是 `panel`——但 `apply` 這次沒被改過。

#### 成因

我重寫 `styles.js` 時，順手把 `probeTheme()` 的回傳從 `{missing:[…]}`
「簡化」成 `[….]`。它在同一個檔案裡、看起來是純函式、沒有任何型別，
但 **bundle 外層讀的是 `probe.missing`**：

```js
const probe = probeTheme(document)
if (probe.missing.length > 0) { … }     // ← 這裡炸
```

推論：**同一個檔案裡的兩個函式之間也有契約**，只是沒有型別把它寫出來。
回傳形狀是介面，不是實作細節——「順手簡化」不適用於它。
修法不是改回舊寫法就好，是在 JSDoc 上把契約寫明（已補）。

> 這個 bug 由 `mount-once` / `bundle` 測試抓到，**不是** render 測試。
> 看得出價值：如果只有 render 測試，這個 bug 會活著進到瀏覽器——
> 症狀是「分頁在、點進去全空」，跟 F22 一模一樣，又得從 console 反推一次。

### F24 ⛔ 排版「全部東西都好像是同一層」

`[使用者]` 回報：**「排版仍然有問題讓我找不著重點，全部東西都好像是同一層的，
我不知道區域之間的轉折。」**

這不是配色問題，是可以量測的層級問題。原本的輸出是 8 個同構 `<div>`：

```
標題(14px/600) + 計數徽章
說明文字(12px 灰)
[搜尋框][按鈕]
  ├ 卡片：名稱(500) v0.0.0(12px灰) ─ 藥丸×3 ─ 換版訊號(11px灰)
▸ 開機載入順序 · 11          ← 12px/500，跟內文一樣重
設定檔：web · fs-base        ← 一整塊 box，跟卡片一樣重
環境：…                      ← 11px 灰
```

三個可量測的病因：

1. **11px 到 14px 只差 3px**——最小的字和最大的字幾乎一樣大。
2. **每個區塊都是獨立框**——`border` 到處都是，於是框不再代表「這裡是內容」。
3. **診斷資料跟清單同權重**——開機 entry 表、manifest 路徑、環境狀態，
   跟「你裝了什麼插件」一樣醒目。

#### 修法：兩個機制，缺一不可

- **結構**：面板改成三個**有名稱的區塊**（`Section`），
  非原裝插件／開機載入順序／環境。原本唯一的區塊感只有一個裸 `<details>`。
- **尺度**：明確定下並**用測試釘住**的 type scale
  （15 / 13 / 12 / 11px，見 `styles.js` 檔頭的表）。
- 每張卡片的 spec 與換版訊號摺進 `<details>`——原本內嵌讓每張卡同高同密度。
- 橫向分隔線只剩兩條（區塊、footer），框重新只代表「內容」。

#### 測試：把「層級」變成可以紅的斷言

`test/hierarchy.test.mjs`（8 個案例）驗兩半：

| 驗什麼 | 怎麼驗 |
|---|---|
| 區塊結構存在 | 從 `panel.js` 原始碼抽出 `h(Section, {title: t('…')})`，要求 ≥3 且不重複 |
| 尺度沒被壓平 | 每個層級的 `font-size` **逐一比對表**，不是「都不一樣」 |
| 頂端真的最高 | `.pm-title` 必須是最大者，且與細節層差 ≥4px |
| 主體大於配件 | `.pm-name` > `.pm-chip` |
| 轉折機制單一 | `.pm-sec` 必須有 `border-top`；全檔橫線數 ≤4 |

**已驗證會紅**（F22/F23 的規矩）：把 `.pm-title` 從 15px 改成 13px →
紅在 `.pm-title should be 15px` 與 `found only 3 distinct sizes across 5 levels`。

> 兩個細節留給下一個改的人：
> (a) 測試用**精確表**而非「都不同」，因為 11px 是兩個層級**故意共用**的；
> (b) 抽 `Section` 的正則要能跨行——formatter 會把長呼叫折行，
> 只寫單行的版本**安靜地只找到 3 個區塊裡的 2 個**，測試照樣綠。

### F23 ⛔ 搜尋框是裝飾品；而**測試替身自己說謊**比沒有測試更貴

`[測]` 症狀：搜尋框在、能打字、**打了完全沒反應**。

成因很單純：`shown`（過濾後的清單）算出來了，但渲染用的是 `plugins`。
輸入框只連到 `setQuery`，沒有任何一處讀 `shown`。**沒有測試會紅**，
因為當時的 render 測試只斷言「有東西渲染出來」。

#### 真正貴的部分：寫這個測試時踩到的兩個替身陷阱

照 F22 的規矩，新測試必須「把 bug 改回去要變紅」。第一次跑，它紅了——
但**紅的理由不是搜尋**。兩個陷阱都不是產品碼的問題：

| 陷阱 | 症狀 | 真相 |
|---|---|---|
| payload 少了 `backend` | 面板渲染 `pm-msg-bad`，我看見「空清單」 | 那是**載入失敗**的分支。`data.backend` 未定義 → 讀 `.fs` 拋錯 → `phase='error'`。面板行為完全正確 |
| `pluginInventory.available:false` | 走進「無法讀取清單」分支，卡片數 0 | 我改了 `thirdParty` 卻留下 fixture 的 `available:false`。**清單不是被過濾掉的，是根本沒渲染** |
| `findByClass(tree,'pm-card')` 永遠 0 | 誤判成「過濾器把卡片吃掉了」 | `h(PluginCard,…)` 是**元件描述子**，`pm-card` 這個 className 要等 React 呼叫元件後才出現——而替身刻意不呼叫。要數的是 **`pm-list` 的 children** |
| `list.children.length` 回 1（清單有 2 張） | 誤判成「只過濾出一張」 | 替身的 `createElement` 收 varargs，`h('div',props,[a,b])` 會在 children 裡留下**一個陣列**。要 `.flat(Infinity)` |

兩個推論：

1. **替身的失敗訊息會指向錯的地方。** 上面四個症狀裡有三個我第一眼看成
   「過濾器壞了」。先確認**替身餵進去的是不是合法 payload**，再懷疑被測程式。
2. **「把 bug 改回去會紅」還不夠，要確認它紅在正確的斷言上。**
   這次補做：把 `shown` 改成 `true`（等於關掉過濾）→ 紅在
   `the query must narrow the list to one card`，才算證明。

> 這條同時是 F22 的補強：F22 說「測試要能看見那個 bug」，
> F23 說「**測試紅的時候要紅在對的理由上**」。兩者缺一，測試就是安慰劑。

### F22 ⛔ 面板崩潰：兩個端點，一個 payload

`[測]` 症狀是**分頁在、點進去空白**，console 給出精確答案：

```
[dsh-plugin-manager] client half ready; tab=plugin-manager order=20   ← apply 成功
TypeError: Cannot read properties of undefined (reading 'clientModules')
    at Panel (client.js:726:1)
client.js:526 slot entry crashed in 'settings.plugins.tab': TypeError: …
```

#### 成因

`overview` 與 `backend` 是**兩條路由**，但面板渲染**一個 `data` 物件**：

```
GET /api/dsh-plugin-manager/overview
  → at, rev, entries, batches, injected, thirdParty, counts,
    inventory, pluginInventory, notices, source      ← 沒有 backend

GET /api/dsh-plugin-manager/backend
  → clientModules, pluginInventory, fs, profileCandidates, node, platform
```

我把 `face.backend()` 做出來了，**卻從來沒在 `load()` 裡呼叫它**。
於是 `data.backend` 永遠是 `undefined`，而那行
`` `clientModules=${backend.clientModules…}` `` 一讀就爆——
**整個分頁的 render 掛掉，所以空白**。

> **⇒ 兩條規則：**
> 1. **面板渲染的物件，就是 client 要負責組裝的物件。**
>    端點有幾個是後端的事；`load()` 必須回一個完整、可直接渲染的 payload。
> 2. **選用欄位容錯，但不要用容錯掩蓋契約錯誤。**
>    面板現在對 `backend` 缺失是防禦的（不炸），
>    而**契約**由 `face: load() merges …` 這個測試單獨守住——
>    否則防禦會把「忘記 merge」變成靜默的空畫面。

#### 為什麼既有測試沒抓到（本專案第二次犯同一類錯）

`test/bundle-exec.test.mjs` 的 `fetch` stub 回的是 **`{}`**，
而渲染測試**根本不存在**。所以「有元件、有 payload」這條路從來沒被走過。

修正後新增 `test/panel-render.test.mjs`，用**真實形狀的 payload**
（鍵集從線上端點抄下來的）驅動 `Panel`，並且：

- `useState` 真的保存狀態、`useEffect` 真的執行
  （否則畫面停在 loading，所有「載入後」的斷言都是空的）
- `createElement` 只回描述物件、**不遞迴呼叫元件**
  （否則 `Panel → Row → …` 會 `Maximum call stack size exceeded`）

#### ⚠️ 最重要的一條：**測試要能證明它會失敗**

我第一版渲染測試**在帶著原 bug 的情況下也全過**——因為 `panel.js` 已經加了防禦，
崩潰重現不出來。那六個測試是裝飾品。

驗法是**把 bug 放回去，確認測試 FAIL**：

```
拿掉 merge → ✖ face: load() merges the overview and backend reports into one payload
還原        → ✔
```

> **⇒ 新增任何「回歸測試」時，先確認它在舊行為下會紅。**
> 不會紅的測試只提供虛假的信心，比沒有測試更糟。

### F21 ⛔⛔ client bundle 的內容是**啟動時**讀進記憶體的

`[測]` 這是最容易誤判的一條：**畫面沒資料，但端點有資料**。

#### 症狀與真相

開發迴圈裡很容易這樣撞上：

| 時間 | 動作 | 結果 |
|---|---|---|
| T1 | 重啟 `dsh web` | 行程把 `src/client/client.js` 讀進記憶體、算出 `rev` |
| T2 | 改 `src/client/*.js` ＋ `npm run build:client` | **磁碟上是新的** |
| T3 | 重新整理瀏覽器 | 瀏覽器拿到 **T1 的舊 bytes**（rev 沒變） |

`[測]` 的實際數字：

```
磁碟上的 bundle : 37,507 bytes  sum=d455c56d  ← 含新程式碼
graph 宣告的 rev : 6ffa8d340c3a              ← T1 算的，對應舊內容
```

於是「磁碟對、瀏覽器錯」——而你會在**兩個地方**同時看到舊行為：

1. **宿主半**的程式碼也是啟動時 import 的（改 `src/host/*` 同樣不會生效）
2. **client bundle** 的 bytes 與 rev 都是啟動時快取的

> **⇒ 規則：改 `src/host/*` 或 `src/client/*` 之後，一律重啟 `dsh web`。**
> `npm run build:client` 只更新磁碟，**不會**通知執行中的宿主。
> 只有 `clientModules.rebuilt(id)`（HMR watch 的掛鉤）會重新雜湊，
> 而它要靠 HMR watch 真的在跑。

#### 診斷它的方法（我實際用的）

不要猜「是前端還是後端」。逐一驗這三層，錯誤會自己現形：

| 層 | 怎麼驗 | 這次的結果 |
|---|---|---|
| 端點 | 直接 `GET /api/dsh-plugin-manager/overview` | ✅ 200，資料完整 → 宿主邏輯沒問題 |
| bundle 有沒有進 graph | `clientModules.graph()` 找我們的 id | ✅ 在，rev `6ffa8d…` |
| **磁碟 vs graph** | 讀 `clientPath` 的大小／校驗，比對 graph 的 `rev` | ❌ **磁碟 37,507 bytes 是新的，rev 是舊的** ← 就是這裡 |

> 第三層是關鍵：**只比對「有沒有在 graph 裡」不夠，
> 要比對「graph 說的那一版是不是磁碟上這一版」。**

#### 順帶學到：`/plugins/??…` 不能直接抓

`[測]` 手動 `GET /plugins/??dsh-plugin-manager/client.js` 回 **404**。
那條路由有自己的請求形狀，所以**要驗「瀏覽器拿到什麼」不能靠手動抓那個 URL**——
要讀 `clientModules.clientPath()` 然後用 `fs` 讀檔。

> ⚠️ **更正（後續實測，見 F38）**：這一條**不再是對的**。用 `graph()` 給的
> **完整 URL（含 `&rev=…`）**去抓，會拿到 **200 與最新的內容**。
> 當年那次 404 是因為我省略了 `rev` 查詢參數（請求形狀不完整），
> 不是因為那條路由不能抓。**結論要改的是「怎麼抓」，不是「不能抓」。**

### F38 ⛔ F21 只對了一半：**宿主半**快取，**client bundle** 沒有

`[測]` 為了知道「使用者不重啟到底能看到什麼」，直接抓了 graph 給的完整 URL：

```
GET /plugins/??dsh-plugin-manager/client.js&rev=74ee0cff2437
→ 200
served length : 107,898
disk   length : 107,814          （差距是傳輸層的正規化，不是版本差異）
served 含新模組 createUpdatePanel : true
```

**所以 client bundle 是每次請求重新從磁碟讀的**，而 graph 宣告的 `rev`
（`74ee0cff2437`）仍然是**啟動時算的舊值**。

⇒ 正確的規則不是 F21 那句「兩邊都要重啟」，而是：

| 改哪裡 | 要重啟嗎 | 重新整理頁面夠嗎 |
|---|---|---|
| `src/client/*` ＋ `npm run build:client` | ❌ **不用** | ✅ 夠（bundle 每次重新讀） |
| `src/host/*`（含新增路由、`inject`） | ✅ **一定要** | ❌ 不夠，端點根本不存在 |

⚠️ **但 `rev` 是舊的**，所以 HMR 與快取失效的判斷會用一個過期的雜湊——
開發時如果畫面行為詭異，**先重啟再說**，不要拿 `rev` 當「我跑到最新版了」的證據。

⚠️ 這一條是**修正一個已經寫下來的結論**。原本的 404 觀測是對的，
但推論（「不能抓」）是錯的：真正的原因是我**漏了 `rev` 查詢參數**。
留下這段是因為下一個人會遇到同一個岔路：**觀測對了，推論可能是錯的**，
而錯的推論會寫進文件變成下一個人的前提。

### F20 側邊欄的「Cordis Plugin」徽章不是本插件的東西

`[碼]` 來自官方套件 `@deepseek-ai/dsh-client-ui-cordis`：

```js
"data-cordis-badge": all.length,          // 徽章數字
"panel.trigger": "Cordis Plugin",
"panel.runningCount": "{count} running",
```

它是**官方動態 Cordis 外掛的面板**：列出當前 session 定義的動態外掛，
提供 Define / Run / Update / Stop / Remove 與 Inspect。

> ⇒ 除錯期間若在那裡看到數字，那是**開過的探針**，不是本插件。
> 收尾時用 `cordis_undefine` 逐個移除即可歸零。

### F14 `harness.defineTool` 的參數與輸出規則**方向相反**（`[測]`）

兩個相鄰欄位對 `additionalProperties` 的要求剛好相反，很容易連錯兩次：

| 欄位 | 規則 | 錯誤訊息 |
|---|---|---|
| `parameters` | **不可**寫 `additionalProperties: false`；要 `true` 或**省略**（隱含參數根是開放的） | `parameters.additionalProperties must be true or omitted because the implicit parameter root is open` |
| `output.schema` | **必須**明確寫 `additionalProperties`（`true` 或 `false`） | `unsupported JSON schema: schema.additionalProperties must be explicitly true or false` |

`parameters` 也可以用**直接 DSL**（純屬性 map，不寫 `type`／`properties`）：
`{ includeEntries: { type: 'boolean', description: '…' } }`。

`harness.defineTool` 的完整形狀（`[碼]` `dsh-cordis-host-runner/lib/index.js:477-513`）：

```js
const tool = harness.defineTool({
  name: 'pm_overview',
  description: '…',
  parameters: { someFlag: { type: 'boolean', description: '…' } },   // 直接 DSL
  output: {
    schema: { type: 'object', additionalProperties: true },           // 必須明寫
    render: (args, value) => [{ type: 'text', text: JSON.stringify(value, null, 2) }],
  },
  execute: (args) => ({ /* 可 JSON 化的東西 */ }),                     // 回傳會被 JSON round-trip
})
ctx.effect(() => harness.registerTool(ctx, tool), 'label')
```

- `output.render` **必須回傳 content block 的陣列**（每項至少要有字串 `type`）
- `execute` 的回傳會經過 `JSON.parse(JSON.stringify(...))`——**不能放活物件**
- 非 `harness.defineTool` 回傳的 tool 不能註冊

---

## 借鏡與反面教材（來源：`zhu1090093659/dsh-web`）

> 全 `[碼]`／二手研究，**未在本機執行**。借用時必須自己實測，不要當成事實。

### 值得抄

| 做法 | 它怎麼做 | 為什麼 |
|---|---|---|
| **不信退出碼** | `dsh plugin add` 回 0 後，再比對 profile `dependencies` 的 key 集合有沒有真的多一條；沒有就判失敗並回滾 | 「成功退出碼不等於安裝落地」 |
| **串行化的尾巴一定要復原** | `queue = result.then(() => {}, () => {})`——任務自己 reject 保留給呼叫端，但佇列尾巴永遠前進 | 一次失敗的寫入不可以卡住後面所有工作 |
| **連不經 CLI 的寫檔也走同一把鎖** | patch 寫入與 bundles 重寫都在同一把鎖內，且在鎖內**重讀**最新 manifest | `pipeline.mjs` 要涵蓋全部寫入路徑 |
| **只剝「本次新增 ∩ 已被 row 掛載」** | 使用者原本就有的條目永不動；寫回失敗就讓任務顯式失敗，不靜默 | 「不破壞使用者檔案」的可操作定義 |
| **bytes-once 解碼** | 累積原始 bytes，讀取時只解一次；strict UTF-8 失敗才在 `gbk`/`utf-8` 中挑 U+FFFD 較少者；截斷點避開 UTF-8 續接位元組 | Windows CP936 下 CLI 錯誤訊息可讀 |
| **owner-aware 歸因** | 預檢失敗時用「輸出尾巴是否含新包名／entry id」決定要不要回滾，不是無條件回滾 | 不誤傷既有插件 |

### 不要抄（每一條都直接關係到本插件的承諾）

| 不要抄 | 它的做法 | 對本插件的意義 |
|---|---|---|
| **預檢放在變更後** | `--dump-config` 只在 install/update **之後**跑；裝前唯一防線是 spec 字元黑名單 | ⛔ 照抄等於放棄唯一賣點 |
| **從不用 `--patch`** | 全 repo 沒有任何 `--patch` 呼叫 | ✅ **這正是空位**：R5「候選 patch 先自我驗證」它完全沒做 |
| **回滾＝官方 remove** | 把新裝的拆掉，不是還原變更前狀態；只憑 `code === 0` 判定成功 | ⛔ 沒有 checksum／逐位元比對，達不到 §9.2「逐位元一致」 |
| **沒有真正的檔案快照** | 「快照」是記憶體裡 before/after 比對，重啟即失 | ⛔ 與「變更前先快照」承諾直接衝突 |
| **備份單份、無時間戳、會被覆蓋** | `<file>.bak-plugin-manager`；`copyFile` 失敗還靜默吞掉（`.catch(() => {})`） | ⛔ 至少要時間戳目錄，且失敗必須報 |
| **整份 `JSON.stringify` 重寫** | 改一個欄位就整份寫回，key 順序不保證保留 | ⛔ 要保守編輯 |
| **宿主半依賴 npm 套件** | 執行期 `import 'yaml'` | ⛔ 直接違反 R1 |
| **網路請求放在變更鎖內** | 版本查詢在鎖內做，逾時 30 秒 → 可卡住安裝佇列 30 秒 | 昂貴的讀取先做完再進鎖 |
| **用 argv 字串掃描推 profile** | `argv.includes('web')` 位置無關掃描 | 任何含 `web` 的引數都會命中 |
| **以 runtime 錯誤字串為假設** | 註解寫死 `webserver: duplicate prefix route "…"`，但宿主真正的樣板是 `` `webserver: duplicate ${kind} route "${path}"` `` | R7「宿主假設集中管理」的活教材 |

### 兩條從宿主原始碼直接證實的高風險行為（`[碼]`）

| 行為 | 證據 | 對本插件的意義 |
|---|---|---|
| 重複 entry id **開機致命** | `cordis-plugin-loader/lib/index.js:91` → `throw new TypeError('duplicate loader entry id: …')` | 所以衝突處置必須回滾，**不能用 `disabled` 掩蓋** |
| patch 行的 `name` 寫錯 → **只 warn、安靜跳過** | `cordis-plugin-include/lib/index.js:96-99` → `patch: name mismatch for … (expected …, got …), skipping` | ⚠️ 開關／覆蓋寫錯 `name` 會「按了沒反應」而**不報錯**——`verify` 應該自己檢查這件事 |

---

## 簽名清單（給 `doctor` 用）

宿主升級後要重跑的檢查。每一條都要能在這裡找到實測值。

| 簽名 | 實測字串 | 出現階段 |
|---|---|---|
| bundle 沒有 `dsh.bundle` | `dsh: profile bundle "X" declares no dsh.bundle in its package.json` | Compose |
| bundle 解析不到 | `dsh: cannot resolve profile bundle "X" from the dsh installation or <dir>` | Compose |
| overlay 檔讀不到 | `dsh: failed to read overlay <file>: …` | Compose |
| overlay 解析失敗 | `dsh: failed to parse overlay <file>: …` | Compose `[測]` |
| config 解析失敗 | `dsh: failed to parse config <file>: …` | Compose |
| 插件載入失敗 | `dsh: plugin(s) failed to load: <names>; Cordis startup failed …` | 樹 settle 後 |
| fatal load failure | `dsh: fatal load failure: <stack>` → exit 1 | 進程級 |
| patch name 不符 | `patch: name mismatch for <target> (expected <a>, got <b>), skipping` | Loader（只 warn） |
| 重複 entry id | `duplicate loader entry id: <id>` → TypeError | Loader（致命） |

> ⚠️ **只准用前綴或結構比對，不准完整字串比對**——宿主用樣板字串組訊息，
> 一個 `kind` 變數就會讓字面值不同（見上節反面教材）。

---

## 未完成（M0 剩下來的）

| # | 待驗 | 怎麼驗 | 阻塞什麼 |
|---|---|---|---|
| **T1** | `--dump-config` 在**假 profile** 上的完整行為 | throwaway profile（`$DSH_HOME` 指向工作區內臨時目錄）跑完上表全部情境 | M1 的 `--dump-config` 包裝層 |
| **T2** | `subprocess` 服務在宿主半內是否可用、不卡死 | 在宿主半用 `subprocess` ＋ `jobs` 真的跑一次 `--dump-config` | ⛔ 只有「回滾/安裝」需要它；**M1 不需要**（見 F7）<br>🟡 **部分完成（F37）**：`subprocess` 已由 `dsh-base` 註冊、封裝層用真子進程測過，但**在真的宿主內**跑一次仍未做 |
| **T3** | `node_modules` 被刪後 `resolveBundleDir` 落不落到 `.dsh-module-fallback` | 假 profile 刪目錄後跑 V1 | `missing-module` fixture 的期望 |
| ~~**T4**~~ | ~~`pluginInventory` 在本 profile 是否真的提供~~ | ✅ **已完成：不提供**（F8） | 已解決——程式碼改成選用 |
| **T5** | **git 直連來源在 lockfile 的長相** | 假 profile 裝 `github:<owner>/<repo>` | ⭐ **「git 版本偵測」差異化的比對鍵** |
| **T6** | 裝後不重啟能否讀到新 patch（A5） | 假 profile 裝測試套件後立刻讀 `node_modules` | 「裝後即驗」 |
| **T7** | 壞鄰居隔離（A6） | 假 profile 塞一個 import 壞掉的插件 | §9.3 測試設計 |
| **T8** | 面板未開＝零請求零寫入（A8） | fetch 監聽釘死 | R4，M1 驗收 |

> **T1 / T3 / T5 / T6 / T7 全部必須在 `$DSH_HOME` 指向工作區內臨時目錄的
> throwaway profile 上做**，不要碰真身。這也正是 `verify.mjs` 未來的測試底座。

---

### F36 ⛔⛔ 實作「更新」時踩到的六個 bug，全部只有測試會抓到

`[測]` 這一輪寫了 `gitrefs.js`（讀 `.git` 的 refs）、`verify.js`、`snapshot.js`、
`pipeline.js`，然後寫測試。**六個 bug 全部是測試抓到的，而且沒有一個會讓主流程看起來壞掉。**

| # | bug | 為什麼危險 | 怎麼被抓到 |
|---|---|---|---|
| 1 | `compareVersions` 把 `MISSING` 段排在**最低** | 每個 release 都會排在自己的 release candidate **後面**，選擇器預選 rc | 測試斷言 `v1.2.0 < v1.2.0-rc.1`（語意：release 較新） |
| 2 | 同一支函式把 `v2` / `v10` 這種**帶前綴的段**當文字比 | `v2.0.0` 被判定比 `v10.0.0` 新——而真實 tag 長這樣：`dsh-v0.1.7-rc.1` | 測試比對 `v2.0.0` vs `v10.0.0` |
| 3 | `row()` 的 `current` 寫成 `headCommit.startsWith(effective.slice(0, 7))` | 40 字元的 commit 問自己「是否以**自己的前 7 碼**開頭」——永遠 false，選擇器永遠標不出「你現在在哪個 ref」 | 測試斷言 checkout 的分支 `current === true` |
| 4 | `readHeadCommit` 的結果**沒有寫回** `head.commit` | 面板的「目前 HEAD」永遠是空的（值只被拿去比對，沒有被使用） | 測試斷言 packed-refs 的 branch 解析得出 commit |
| 5 | `parseRemoteUrl` 先判 `scp` 形狀，才判本機路徑 | `C:\code\repo` 也符合 `host:path`，於是**磁碟機代號變成 remote host**「c」 | 測試斷言 `C:\code\repo` 的 `kind === 'local'` |
| 6 | `parseRemoteUrl` 成功時忘記設 `kind = 'network'` | 呼叫端的 `kind === 'network'` 判斷在這台機器**唯一真實的 remote 拼法**上全部失敗 | 測試斷言 `git@github.com:o/r.git` 的 `kind` |
| 7 | `verifyBundles` 只檢查**有出現在 `dependencies`** 的 bundle | 「從依賴移除、但 `bundles` 還留著」正是它要抓的壞狀態，卻被跳過 | fixture 宣告一個未安裝的 bundle，期望**拒絕**，結果得到 pass |
| 8 | `parentPath('C:\\a')` 回 `'C:'` | 磁碟機相對路徑指到別的檔案 | 純函式測試 |
| 9 | `planUpdate` 檢查 `git.available`，而它自己讀 repo 的那支函式**從不設這個欄位** | `git.available !== true` **恆真** → 每一台機器上「移動 checkout」的計畫**全部**被拒，連 git 正常的機器也一樣。錯誤訊息長成 `git is required … and it is unavailable: undefined`——那個 `undefined` 就是線索 | 新增測試：給一個**可用**的 git 探測結果，期望 `plan.ok === true` |
| 10 | `carriesDsh()` 只檢查有沒有 `dsh` 鍵，**沒有檢查 `dsh.profile`** | 每一個插件套件都有 `dsh.bundle`（本套件也有），所以「有 `dsh` 鍵」正是**插件**的樣子。而 `tryFromBase` **先試 `fs` 基準目錄** → 只要 `dsh web` 的工作目錄是某個插件 checkout，該插件的 `package.json` 就被當成 profile：它沒有 `dependencies`，面板於是回報**零個已安裝插件**，而真正的 profile 從來沒被問到 | 新測試把 `DSH_HOME` 指向 fixture profile，結果仍拿到 `source: 'fs-base'`——fixture 沒錯，**探索**錯了 |

> **三條可帶走的教訓**
>
> 1. **`compareVersions` 的方向被寫錯兩次，而測試也被改過兩次。** 最後的修法不是改
>    某一邊，而是把契約**寫成表格**（負數＝左邊較新＝排前面）並讓測試用
>    「每一邊是什麼」命名參數。方向有兩個合理解讀時，唯一安全的做法是把解讀寫下來。
> 2. **`fixture` 說謊比 fixture 從缺更貴（F23 的同一堂課）。** 假 `fs` 的
>    `resolve('.')` 回的是**這個 repo**而不是假 profile，於是
>    `buildPluginInventory` 讀到 repo 的 `package.json`、宣告 0 個 bundle，
>    所有 fixture 檢查都「通過」——直到有一個測試期望**拒絕**才露出來。
> 3. **一件壞掉的救援路徑，主路徑完全看不出來。** bug 3／4 只影響顯示，
>    bug 1／2 只影響預選，bug 6 只影響一個布林值。它們全部通過了「跑得起來」的檢查。
>
> **第 9 個 bug（下一輪才抓到）值得單獨記一句**：它是**兩個正確的設計被接錯線**——
> `gitFacts()` 回的是「這個 repo 的狀態」，而 `planUpdate` 問的是「這台機器有沒有 git」。
> 兩個問題都合理、各自的答案都對，接在一起卻讓功能**在任何機器上都失效**。
> 而且它只影響「按下更新之前的預覽」，所以**不會有任何流程報錯**——
> 使用者只會看到一顆永遠停用的按鈕。
> ⇒ 教訓：**當一個物件同時代表兩件事，用兩個名字。** 現在探測結果走 `probe.git`，
> repo 狀態走 `classified.git`，而且 `null` 明確代表「沒有探測過」而不是「不可用」。
>
> **第 10 個 bug 是同一種病的另一面：一個「差不多對」的守衛。**
> `carriesDsh` 問「有沒有 `dsh` 鍵」，而真正的問題是「有沒有宣告 profile」。
> 在一個**插件即套件**的生態裡，這兩件事幾乎總是同時成立——直到它不成立的那一天，
> 而那一天的樣子是「面板什麼都看不到，也不報錯」。收緊成 `dsh.profile` 之後，
> 錯誤訊息也從 `carries no dsh` 改成 `carries no dsh.profile`，
> 因為前者讓下一次讀到這行的人以為檢查的是別的東西。

### F35 ⛔ PowerShell 的 HTTPS 在這台機器上是壞的——`curl` 也是

`[測]` 為了「查遠端有哪些 tag」，先試了最直覺的路：

```
Invoke-RestMethod https://api.github.com/…
→ HttpRequestException: The SSL connection could not be established
  → AuthenticationException → Win32Exception: 安全性封裝沒有可供使用的認證

curl.exe https://api.github.com/…
→ curl: (35) schannel: AcquireCredentialsHandle failed: SEC_E_NO_CREDENTIALS (0x8009030e)
```

`api.github.com` / `github.com` / `example.com` / `google.com` **全部失敗**；
DNS 正常（`20.205.243.168`）、TCP 443 也通。所以是 **Windows Schannel 認證層**的問題，
不是網路、不是 GitHub。

**但 Node 24 的 HTTPS（OpenSSL 堆疊）完全正常。** 同一台機器、同一個時刻：

| 項目 | 實測 |
|---|---|
| `tags` 欄位 | `name, zipball_url, tarball_url, commit{sha,url}, node_id` |
| 未認證 rate limit | `limit=60`，回應標頭 `x-ratelimit-limit: 60` |
| 不存在的 repo | HTTP **404**，body `{"message":"Not Found"}` |
| CORS（`Origin: http://127.0.0.1:3080`） | `access-control-allow-origin: *`，`OPTIONS` 204 也放行 |

**⇒ 架構後果**：遠端 ref 查詢**不能用 PowerShell、不能靠系統 TLS**，
必須由 Node 自己發請求。本插件的做法是
**spawn 一個 `node -e <literal>` 子進程**去 `fetch`，網址以 base64 傳入：

- 憑證（私庫的 token）走 **argv 而不是環境變數**——`subprocess` seam 的
  `SENSITIVE_ENV_PATTERN` 會**靜默**把 `GITHUB_TOKEN` 這類名字從子進程環境裡剃掉；
- 子進程只印 JSON，**不由 shell 解讀任何字元**；
- 這一條路是整個套件**唯一**會離開這台機器的程式碼，而且它是一條 **POST** 路由——
  所以按 F5、prefetch、或點到連結都不可能觸發它。

### F37 `subprocess` 服務在本部署**確實被註冊**（T2 的前半）

`[碼]` `@deepseek-ai/dsh-base/cordis.patch.yml:199`：

```yaml
    - id: subprocess
      name: '@deepseek-ai/dsh-subprocess-local'
```

沒有 `disabled:`，也不在任何被 patch 掉的行裡。所以 `ctx.get('subprocess')`
在真實部署拿得到一個有 `resolveExecutable` 與 `spawn` 的服務。

`[碼]` 它的介面（`@deepseek-ai/dsh-subprocess` 的型別定義）決定了封裝層的形狀：

| 事實 | 後果 |
|---|---|
| `spawn(spec)` 的 `argv[0]` 是程式，**永不經 shell 解讀** | 所以 Windows 的 `dsh.ps1` 不能用；必須 `node <…>/lib/bin.js`（A3） |
| `stdio` 每個 stream **都必須明寫**，seam 不給預設值 | `runProcess` 一定送完整的 `stdio` 物件 |
| `graceMs` 必填、正的有限值 | 送 `SPAWN_GRACE_MS` |
| 逾期用 `AbortSignal`，服務負責終止**整個 managed range** | 逾時不需要自己寫 kill 階梯（測試驗過：300 ms 的 deadline 真的把一個 30 秒的子進程結束掉） |
| 憑證形狀的環境變數**會被剃掉** | token 只能走 argv |
| 收集模式是 **offset-based、非消耗性** | 結束後 `readFrom(0)` 就是批次結果 |

**仍未驗的**：把這一整套放進**真的宿主行程**裡跑一次（要重啟 `dsh web`，見 §8.2）。

