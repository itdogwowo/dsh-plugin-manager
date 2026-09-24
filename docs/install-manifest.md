# 插件安裝清單（design ＋ 計劃）

> **這份文件的用途**：記錄「像 docker compose / requirements.txt 的安裝清單」這個功能的設計。
> 使用者面向的說明寫完之後進 `README.md`；交接待辦仍然記在 `docs/plan.md`。
>
> 狀態：**設計已定案，第一階段施工中**。三個關鍵決策由使用者選定（§2）。

---

## 1. 為什麼要做這個

生態裡七個同類插件（`docs/plan.md` §4.4）**沒有一個有宣告式清單**：
它們都是「一顆一顆點」的 UI。這造成兩個具體的痛：

1. **換機器要重建整個 profile**：目前只能靠記憶把十幾顆插件一顆一顆 `dsh plugin add`。
2. **順序與版本沒有記錄**：`package.json` 記的是結果，不是「我打算裝什麼」。
   想 review 一個 profile 的插件組成，得自己讀 manifest 反推。

而 DSH 的失敗模式讓這件事更痛：**漏裝或漏移除一顆都可能讓 `dsh web` 起不來**。

---

## 2. 已定案的三個決策

| # | 決策 | 選了什麼 | 為什麼 |
|---|---|---|---|
| **D1** | 清單語意 | **只加不刪**；孤兒（裝了但不在清單）**列出來**，手動確認才移除 | `requirements.txt` 式。外掛清單若預設收斂，**漏寫一行就等於移除一顆外掛**，而移除是會讓宿主起不來的操作 |
| **D2** | 檔案位置 | **`$DSH_HOME/.dsh-pm/plugin-manifest.yml`** | 與快照同一個家（§6.3 的 `.dsh-pm/`），不污染 profile 目錄，也不會被官方 CLI 的 reconcile 動到 |
| **D3** | 第一步 | **面板的安裝輸入框 ＋ 計畫預覽** | 最小步：接上**已經存在**的 `apply` 路由（`routes.js` 早就支援 `verb: 'add'`，只是沒有介面呼叫它），順便補上 `add` 缺的計畫預覽 |

### D3 為什麼是第一步（實測的缺口）

規劃這個功能時查到的現況，全部是實測不是推測：

| 事實 | 位置 | 後果 |
|---|---|---|
| `apply` 路由**已經**支援 `verb: 'add'` | `routes.js:545,570-572` | 管道（驗→影→裝→再驗→回滾）對安裝**早已可用**，只是沒人叫它 |
| 面板**沒有任何安裝 UI** | `panel.js` 只有搜尋框與「檢查／重新讀取」 | 只能走 CLI，等於放棄管道 |
| `plan` 路由**只支援 update** | `routes.js:437-509` 走 `classifyUpdate`，找不到已裝插件就回錯 | 「按了沒反應」與「先給計畫再給按鈕」這兩條承諾，安裝路徑都不成立 |
| `add` 路徑對 spec **完全沒有驗證** | `src/host` 全樹 grep 不到任何 spec 檢查 | 接 UI 之前必須先補（§4.1） |

> ⚠️ **`add` 現在是唯一沒有守門的變更路徑。** `update` 會先分類、`remove` 會被 manifest 擋，
> 只有 `add` 是「使用者給什麼字串就 spawn 什麼」。這不是理論風險——`spec` 以 `-` 開頭就會被
> 官方 CLI 當成選項。所以第一階段有兩個交付物：**輸入框** 與 **spec 守門**。

---

## 3. 清單檔格式

放在 `$DSH_HOME/.dsh-pm/plugin-manifest.yml`。**扁平 YAML 子集**——零依賴下（R1）
自己解析得到，代價是不支援巢狀結構，而清單本來就是扁平的。

```yaml
# 我的 web profile 插件清單
version: 1
profile: web

plugins:
  dsh-plugin-manager: github:itdogwowo/dsh-plugin-manager
  some-registry-plugin: ^1.2.0
  another: github:owner/repo#v0.9.0
  local-work: link:<你 clone 的位置>/dsh-plugin-manager
```

**語意**

| 欄位 | 意思 |
|---|---|
| `version` | 清單格式版本。**讀到不認識的版本要報錯，不是猜著讀** |
| `profile` | 這份清單描述哪個 profile。與實際不符時**警告**（清單可以跨機器共用，profile 名可能不同） |
| `plugins` | `套件名: spec`，一行一顆。spec 就是 `dsh plugin add` 收的那個字串 |

**三個刻意的限制**

1. **`plugins` 必須是扁平映射**，巢狀結構一律報錯——寧可抱怨，不要靜默讀成空清單。
2. **不支援 `remove:` 段落**：D1 選了只加不刪，孤兒由面板列出來。
3. **解析失敗要說第幾行**（比照 `--patch` 的錯誤語意，`docs/plan.md` §5.5）。

> ⚠️ **`link:` 的絕對路徑不該進版控。** 清單可以 commit 進你自己的專案（那是它的價值），
> 但裡面若有 `link:C:\Users\<你的帳號>\…` 這種本機路徑，就違反公開 repo 的個資紅線。
> 要共用時用相對路徑（相對於清單檔），或把那一行留在本機。

---

## 4. 不變的規則

這個功能**不新增任何旁路**，既有硬規則全部照舊：

| # | 規則 | 這個功能怎麼遵守 |
|---|---|---|
| **R1** | 零執行期依賴 | YAML 子集解析器自己寫，不引入 `js-yaml` |
| **R4** | 不在啟動路徑上做事 | 解析清單只在請求時發生；面板沒開＝零讀取 |
| **R5** | 變更前必先快照 | 同步的每一顆都走 `runPipeline`，一顆一個快照 |
| **R6** | 不寫使用者的 `cordis.patch.yml` | 清單檔在 `.dsh-pm/`，與 profile 圖層無關 |
| **R7** | 宿主假設集中在 `host.js` | 清單路徑從既有的 `.dsh-pm/` 常數來，不新寫死一個 |

### 4.1 spec 守門（`checkPackageSpec`）

`spec` 是**資料不是指令**——它進的是 argv 陣列，不是 shell 字串，所以沒有 shell injection。
但它仍然必須驗，因為它會變成**官方 CLI 的一個參數**：

| 拒絕 | 為什麼 |
|---|---|
| 空值 | `add ''` 沒有意義，而且錯誤訊息來自 pnpm，很難懂 |
| 開頭是 `-` | 會被當成 CLI 選項（`--help`、`--global`…）。這是最實際的風險 |
| 任何控制字元／換行 | 值裡不該有，有就是有人在探 |
| shell 特殊字元（`$;&\|<>()`＋引號＋反斜線） | ⚠️ **不是**防 shell injection（這裡沒有 shell）。是因為它們出現在套件欄位裡，代表有人把一整行指令貼錯了地方 |
| 非 ASCII 可見字元 | 同上；也順便擋掉同形字攻擊 |
| 超過 1024 字元 | 合法的 spec 不會這樣長 |
| `@` 開頭但沒有 `/` | scoped 套件一定是 `@scope/name`；`@1.2.3` 這種是打錯 |

**誤殺的出路**：驗證器若擋掉合法的 spec，使用者**仍然可以用官方 CLI 裝**，
而且拒絕訊息裡就附著那行指令。面板是方便，不是唯一入口——所以守門可以從嚴。

**已知的代價**：反斜線被拒，所以 Windows 路徑要寫成正斜線
（`link:C:/Users/<你的帳號>/dir`）。實機 profile 記的正是正斜線這種形式，
所以這條代價比看起來小；但拒絕訊息必須說出替代寫法，否則就是一道牆。

---

## 5. 分階段計劃

| 階段 | 內容 | 狀態 | 完成定義 |
|---|---|---|---|
| **S1** | 面板安裝輸入框 ＋ **`add` 的計畫預覽** ＋ `checkPackageSpec` 守門 | 🟢 已寫且有測試（29 個）；**未在真的 `dsh web` 上按過** | 面板打一個 spec → 看到「會跑什麼指令」＋「dsh 在不在」→ 按下去走完整管道；守門有測試 |
| **S2** | 清單檔：解析器 ＋ 差異比對（缺／多／已是最新） ＋ 產生指令 | ⬜ | 面板貼一份清單 → 看到逐顆的計畫；**這一步不碰 profile** |
| **S3** | 逐顆同步 ＋ 孤兒清單 ＋ 同步後報告 | ⬜ | 一次同步多顆，每顆各自快照；失敗只回滾那一顆 |

**S1 拆解**

| 檔案 | 改什麼 |
|---|---|
| `src/host/pipeline.js` | 新增並匯出 `checkPackageSpec`、`nameFromSpec`、`planInstall`、`planRemoval` |
| `src/host/routes.js` | `plan` 接受 `verb=add\|remove`；`apply` 的 `add` 路徑先過守門（**兩個執行點，一次驗證**） |
| `src/client/face.js` | `planInstall(spec)`、`planRemove(name)` |
| `src/client/panel.js` | 安裝欄位：輸入框、計畫預覽、執行鈕、結果 Notice |
| `src/client/copy.js`、`styles.js` | zh／en 文案；`.pm-install*`、`.pm-code`、`.pm-btn-run` |
| `test/install-plan.test.mjs`（22）、`test/panel-render.test.mjs`（＋7） | 守門的接受／拒絕清單；計畫的三種狀態；渲染的三種狀態 |

**S1 實作時發現的兩件事**（都寫進測試了）：

1. **守門的順序是實作的一部分。** 第一版寫在 `resolveChangeContext` 之後，所以壞 spec 會先拿到
   「讀不到 profile」。現在它跑在所有 profile 讀取之前，並且用「這個 stub 沒有 profile」
   把順序釘住——一個會回錯答案的檢查器，比沒有檢查器更難查。
2. **`findByClass` 看不穿 component descriptor。** 拒絕訊息的內容在 `Notice` 的 props 裡，
   而測試 stub 從不呼叫 component，所以樹上找不到。改用 props 走訪斷言——
   這不是比較弱的測試，是唯一可用的那個。

---

## 6. 驗收標準

**S1**

- [x] 面板輸入 `github:owner/repo` → 顯示 `dsh plugin --profile web add github:owner/repo` 與 `dsh` 探測結果
- [x] 輸入 `--global` → **計畫階段就被拒**，且說得出拒絕的理由
- [x] 輸入一顆已經裝了、spec 也相同的插件 → 顯示「已經是同一個 spec」
- [x] 輸入一顆已裝但 spec 不同的插件 → 顯示這會**改寫**已記錄的 spec
- [x] `dsh` 不可用時，計畫說得出缺什麼（與 update 路徑一致）
- [x] 按下去走完整管道：裝前驗 → 快照 → 執行 → 再驗 → 失敗自動回滾（沿用既有 `runPipeline`，未改動）
- [x] `npm run verify` ＋ `npm test` 全綠（**255 pass**，其中 29 個是本輪新增）
- [ ] **在真的 `dsh web` 上按過**——要重啟宿主，見 `docs/plan.md` §8.2

**S2／S3**（見 §5）

- [ ] 清單解析錯誤說得出第幾行
- [ ] 不認識的 `version` 報錯，不是猜著讀
- [ ] 同步只做加法；孤兒列出來但不動
- [ ] 每一顆變更都有**自己**的快照（不是整批一個）

---

## 7. 風險

| 風險 | 對策 |
|---|---|
| **YAML 子集解析器寫錯，把清單讀成空的** | 「讀不到」與「空清單」必須是**不同**的結果。空清單要能區分「檔案是空的」與「解析失敗」（比照 `inventory.available` 的既有做法） |
| 誤殺合法 spec | 從嚴，並在錯誤訊息裡明說「你可以改用官方 CLI 裝」（§4.1） |
| 清單與實際 profile 漂移 | 清單是**意圖**，profile manifest 是**事實**。面板永遠顯示兩者差異，不假裝一致 |
| 一次同步太多顆，中途失敗 | D1 的只加不刪 ＋ 一顆一快照：失敗的那顆回滾，已成功的不動 |
