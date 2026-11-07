# 構造化ログの設計

Director の診断ログを、1 行 1 イベントの JSON Lines にする設計です。親 Issue は #75 で、実装の PR はこの文書を正とします。LogTape の挙動は 2.4.2 のソース（npm の配布物の `dist/`）で確かめました。

## 1. 背景

ログが、障害の原因を後から追える形になっていませんでした。次の表は `9570fe3` で確認した状態です。場所は関数名で書きます。

| # | 現状 | 場所 |
|---|---|---|
| C1 | プロセスのログは `console.error` / `console.log` の非構造化な文字列で、あちこちに散らばっている | `src/director.mts` の `readConfig`、`src/http.mts` の `openPairing` と `createServer` の catch 節、`main.mts` の起動行 |
| C2 | ADE モードでは stdout と stderr の両方が `.vork/server.log` に追記される。ローテーションも上限も無い | `mcp.mts` の `director()`（子プロセスの `stdio`） |
| C3 | HTTP 500 は `console.error(e)` だけで、method・path・相関キーが残らない。`Refusal('failed')` による 500 は何も出ない | `src/http.mts` の `createServer` の catch 節 |
| C4 | ジョブの失敗は `job.steps`（メモリ上、`JOB_TTL` で消える）にしか残らない。render の失敗は `failJob` も通らない | `src/director.mts` の `newJob`、`failJob`、`startRender` |
| C5 | audit の `agent_error` は message の文字列だけで、job id もエラーの種類も無い | `src/director.mts` の `startPropose` |
| C6 | audit にジョブやリクエストとの相関キーが無い | `src/director.mts` の `audit` |
| C7 | MCP モードでは stdout がプロトコルの通り道で、ログ出力で汚してはいけない | `mcp.mts` の `log` |
| C8 | spawn エラーの own property `spawnargs` に `#pair=<PAIR>` が入っている。Error を丸ごとログに渡すと漏れる | `src/http.mts` の `openPairing` |

## 2. 出力先

| 出力先 | 中身 | 既定のレベル |
|---|---|---|
| `<runs>/logs/director.jsonl` | 全イベント。JSON Lines。5MB を超えると `director.jsonl.1` へ回し、`.3` まで残す（ファイルは最大 4 つ） | `info`（`RENDER_DIRECTOR_LOG_LEVEL` で変える） |
| stderr | warning 以上のイベント。書式はファイルと同じ JSON Lines | `warning` |
| stdout | ログ設定からは 1 バイトも書かない | なし |

- `<runs>` は ADE モードでは `<project>/.vork/`、単独モードでは `runs/` です。
- ADE モードでは stderr が `.vork/server.log` に入ります。`server.log` に残るのは、warning 以上の構造化ログ、起動行（`console.log`）、ログ設定より前の致命的エラー（`console.error`）、Node のクラッシュ出力です。
- `RENDER_DIRECTOR_LOG_LEVEL` は `trace / debug / info / warning / error / fatal` のどれかです。それ以外の値は `info` として扱い、`config.invalid` を 1 件書きます。
- `mcp.mts` は変えません。MCP の stdout はプロトコルの通り道で、診断は今の `process.stderr.write` で足ります。

## 3. 共通フィールド

全イベントが次のフィールドを持ちます。

| フィールド | 内容 |
|---|---|
| `@timestamp` | ISO 8601（UTC） |
| `level` | `TRACE / DEBUG / INFO / WARN / ERROR / FATAL`。LogTape の `warning` は `WARN` と表記される（`formatter.js:557`） |
| `logger` | `render-director.<component>` |
| `message` | 人が読む固定文 |
| `service` | 常に `"render-director"` |
| `component` | `main / http / director` など、イベントを書いたモジュール |
| `event` | イベント名（次節） |

相関キーは、そのイベントが属する処理単位がある場合に付きます。

| キー | 付く範囲 | 付け方 |
|---|---|---|
| `reqId` | 1 件の HTTP リクエストの中で書かれたイベントと、そのリクエストから始まったジョブ | `createServer` のコールバック全体を `withRequest(reqId, fn)`（`withContext({ reqId })`）で包む。`crypto.randomUUID().slice(0, 8)` |
| `jobId` / `kind` / `versionId` | 1 つのジョブの中で書かれたイベント | `withJob(job, fn)` が `withContext` を張る。`src/director.mts` の `inJob` がジョブ本体をこれで包む |

`withContext` は `AsyncLocalStorage` で値を運ぶので、`await` をまたいでも届きます。EventEmitter のリスナ（`res.on('finish')` など）には届かないため、そこで書くイベントは相関キーをクロージャで捕まえて明示的に書きます。

## 4. イベント語彙

| event | level | 主なフィールド | 書く場所 | Issue |
|---|---|---|---|---|
| `director.start` | info | `mode, port, vorkVersion, pid` | `main.mts` で待ち受け開始の直後 | #78 |
| `director.stop` | info | `signal` | `main.mts` の `cleanup`（SIGINT / SIGTERM / SIGHUP） | #78 |
| `director.fatal` | fatal | `origin` と `errFields` | `server.mts` の `main()` の catch、`uncaughtExceptionMonitor`、vork が見つからないとき | #78 |
| `config.invalid` | warning | `file, errorType`（`config.json`）、`source, errorType`（環境変数） | `readConfig`、`RENDER_DIRECTOR_BROWSER` の解析、`RENDER_DIRECTOR_LOG_LEVEL` の検査 | #77, #78, #79 |
| `http.request` | GET で 400 未満は debug、5xx は error、それ以外は info | `reqId, method, route, status, ms`。切断時は `aborted: true`。500 では `errFields` | `res` の `finish` と `close` のうち先に来たほうで 1 回だけ | #79 |
| `browser.open_failed` | warning | `opener`（`opener[0]` だけ）, `code` | `openPairing` の spawn の `error` | #79 |
| `audit` | info | `auditEvent` と許可リストの項目（第 6 節） | `audit()` の `state.json` への追記の後 | #80 |
| `job.start` | info | `jobId, kind, versionId` | `src/director.mts` の `inJob`（`withJob` で包んだジョブ本体の入口）。背景ジョブは `runJob` が、`agentPropose` / `agentRender` は `newJob` の直後に通す。`newJob` では書かない（終わりの無い start を残さないため） | #81 |
| `job.end` | 失敗は warning、それ以外は info | `jobId, kind, versionId, status, ms`。例外なら `errFields`（built-in proposer の `propose` ジョブは `message: false`）、vork の失敗なら `exitCode, timedOut, vorkLogTail`（末尾 2000 字） | ジョブ終了の集約点 `endJob`（#70）で 1 回だけ。2 回目の呼び出しは何もしない | #81 |

補足:

- `route` は正規化した値です。`/runs/…` は `/runs/*`、`/api/jobs/<id>` は `/api/jobs/:id`、`/api/jobs/<id>/cancel` は `/api/jobs/:id/cancel`、既知の `/api/*` はそのまま、それ以外の `/api/*` は `/api/other`、静的ファイルは `/static` です。生のパスとクエリは書きません。
- `job.end` の相関キーは job オブジェクトから明示的に書きます。`cancelJob` はキャンセル要求の context で動くので、ALS からは正しいキーが取れません。
- `job.end.ms` は `clock` から計算します（#66）。
- audit には `job_failed { jobId, kind, version, errorType?, exitCode?, timedOut? }` を足します。対象は `jobs` に載るジョブで、Refusal 以外の失敗に限ります。Refusal は `agent_proposal_rejected` や `agent_error` と重複し、UI の audit 一覧（直近 60 件）を押し流すためです。
  - `JobOutcome` の `refusal: true` が「Refusal 扱い」の印です。`agentPropose` / `agentRender` の失敗と、`startPropose` の失敗（例外は `agent_error` が記録し、policy や vork に退けられた提案と空の応答は今も audit に残さない）に付けます。
  - `job_failed` の `kind` はジョブ種別なので、ログにも `kind` のまま転記します（第 6 節の規則 4 の `checkKind` への改名は、それ以外の audit の `kind` に限る）。
- `agentPropose` / `agentRender` の結果はエージェントへの HTTP 応答で返るので、ジョブは記録するだけです。応答は変えません。`jobs` に載らないジョブなので、終わると `status` は `done` / `failed` になりますが、`/api/state` や `/api/jobs/:id` からは見えません。

## 5. `src/log.mts`

LogTape への依存はこの 1 ファイルに閉じ込めます。他のモジュールは `@logtape/*` を import しません。

| API | 役割 |
|---|---|
| `setupLogging({ dir, level, stderrLevel = 'warning', maxSize = 5_000_000, maxFiles = 3, testSink? })` | ログ設定。`dir` の下に `logs/` を作る |
| `log(component)` | `info / warn / error / debug / fatal(event, msg, props)` を持つロガーを返す |
| `withJob(job, fn)` | ジョブの相関キーを context に張って `fn` を実行する。`job.start` は書かない（`src/director.mts` の `inJob` が書く） |
| `withRequest(reqId, fn)` | `reqId` を context に張って `fn` を実行する。そこで始まったジョブにも引き継がれる |
| `errFields(e, { message = true })` | Error を `{ errorType, error?, stack? }` に正規化する |
| `shutdownLogging()` | 設定を外す。冪等。以後のログ呼び出しは何もしない |

### LogTape の既定動作を打ち消す設定

LogTape は `configure()` しないと何も出力しません。設定したうえで、既定のままだと困る動作を次のように打ち消し、`test/log.mts` で固定します。行番号は `@logtape/logtape` と `@logtape/file` 2.4.2 の `dist/` のものです。

| # | 既定の動作 | 困ること | 設定 | 根拠 |
|---|---|---|---|---|
| 1 | 2 回目の `configure` は例外になる | 試験で何度も設定し直せない | `configureSync` に `reset: true` を付ける | `config.js:193` |
| 2 | `getStreamSink` は非同期 dispose を持つ | `configureSync` に渡すと `ConfigError` になる | stderr sink は自前の同期関数 `(r) => process.stderr.write(fmt(r))` にする。dispose は持たせない | `sink.js:124`、`config.js:361-362` |
| 3 | `getConsoleSink` は info を `console.info`（stdout）に出す | MCP の stdout と `server.log` を汚す | console sink は使わない | `sink.js:285,297` |
| 4 | meta logger `['logtape','meta']` を設定しないと console sink が自動で付き、設定のたびに info の案内文を出す | stdout に `LogTape loggers are configured` が出る | meta logger を `lowestLevel: 'warning'` で stderr sink に必ず設定する | `config.js:378-380` |
| 5 | file sink は 8KB たまるまで書かない | 終了直前のイベント（`director.stop`、`director.fatal`）が残らない | `getRotatingFileSink(..., { bufferSize: 0 })`。代わりに 1 レコードごとに `fsync` が走る | `filesink.base.js:357,432-434` |
| 6 | context は設定しないと使えない（`withContext` が meta に警告を出して素通りする） | 相関キーが付かない | `contextLocalStorage: new AsyncLocalStorage()` | `context.js:22-24` |
| 7 | file sink はディレクトリを作らない | 初回起動で `ENOENT` | `logs/` を先に `mkdirSync({ recursive: true })` する | `filesink.factory.node.js:12-14` |
| 8 | JSON Lines の `properties: 'flatten'` はプロパティを最上位に展開し、同名のキーを上書きする | `message` などのプロパティで本来の `message` が消える | ラッパーが `message / level / logger / @timestamp` を `x_<key>` に改名する | `formatter.js:553-560` |
| 9 | 不正なレベル文字列のまま設定すると、以降のログ呼び出しが `TypeError` を投げる | 環境変数の打ち間違いで Director が落ちる | `isLogLevel` で検査し、不正なら `info` に戻して `config.invalid` を書く | `level.js:66`（`compareLogLevel`） |
| 10 | メッセージはテンプレートで、`{key}` がプロパティで置き換わる | 文に `{` があると意図しない値が入る | `msg` は固定文にし `{` を含めない。含んだ場合はラッパーが `{{` / `}}` にエスケープする | `logger.js:1189-1224` |

ファイル形式は `getJsonLinesFormatter({ properties: 'flatten' })` です。ローテーションは `director.jsonl` → `.1` → `.2` → `.3` の順に名前を送るので、`logs/` のファイル数は最大 `maxFiles + 1` です（`filesink.base.js:371,414`）。

`bufferSize: 0` の代償は、1 イベントごとの `writeSync` と `fsync` です。Director のイベントは HTTP リクエストとジョブの単位で、毎秒数十件を超えない想定なので許容します。`GET` の 400 未満を debug に落としているのは、画像の取得で件数が増えるのを抑えるためでもあります。

## 6. 漏洩防止の規則

1. **生の Error を logger に渡さない。** 必ず `errFields(e)` を通す。LogTape の JSON 書式は Error の own key をすべて書き出すので（`formatter.js:295`）、spawn エラーの `spawnargs` に入った `#pair=<PAIR>` が漏れる（C8）。`errFields` が返すのは `errorType`（`e.name`）、`error`（message、2000 字まで）、`stack`（4000 字まで）だけ。
2. **message にユーザー入力が入りうる Error は `errFields(e, { message: false })`。** built-in proposer のエラー（`proposer.mts` の `claude exited …`）には claude の出力の末尾 600 字が入り、指示文を含みうる。このとき `stack` も先頭の `Name: message` 行を除いた呼び出し位置の行だけにする。
3. **ユーザー入力は長さだけ書く。** 指示文は `instructionLen`。`comment` と自由入力の `reason` は書かない。
4. **audit の転記は許可リスト。** 許可する項目は `version, request, jobId, job, via, flags, selection, seconds, errorType, exitCode, timedOut, head, mode, node, field, overwrote, slug, parent, base, hash`。`reason` は `'version discarded'` などのシステム定型文に限る。audit の `kind`（`blocked | invalid`）はログ側で `checkKind` に改名する（明示したプロパティがコンテキストの `kind`＝ジョブ種別を上書きするため）。`job_failed` の `kind` はジョブ種別なので改名しない。
5. **秘匿値を書かない。** `agentToken`、ペアリング用トークンとリンク、Cookie は、どのイベントにも入れない。`RENDER_DIRECTOR_BROWSER` の解析エラーは値を含みうるので message を書かず `errorType` だけにする。`browser.open_failed` は `opener[0]` と `code` だけ。
6. **`@logtape/redaction` には頼らない。** フィールド名でしか照合せず Error の中も見ないので、規則 1 の漏洩を防げない。

## 7. ADR: LogTape を `src/log.mts` に閉じ込めて使う

- **Decision**: LogTape 2.4.2（`@logtape/logtape` と `@logtape/file`、`^` を付けずに固定）で診断イベントを `<runs>/logs/director.jsonl` に JSON Lines で書く。LogTape の import は `src/log.mts` だけに置き、既定動作のうち困るもの（第 5 節）を明示的に打ち消して試験で固定する。audit は `state.json` に置いたまま、相関キーだけを足し、許可リストの項目を診断ログへ転記する。
- **Drivers**:
  - 障害の原因を `reqId` / `jobId` で 1 本に辿れること（C3〜C6）
  - stdout を汚さないこと（C7、MCP のプロトコル）
  - 秘匿値と指示文を書かないこと（C8）
  - 終了直前のイベントを失わないこと（`director.stop`、`director.fatal`）
  - ファイルが上限なく増えないこと（C2 のうち Director が書く分）
- **Alternatives**:
  - 自前の logger: 依存は増えないが、ローテーションを自前で保守することになる
  - Pino: ローテーションに worker thread の transport が要り、終了時の flush が複雑になる
  - `@logtape/redaction`: フィールド名でしか照合せず、Error の中も見ない
  - audit を診断ログへ統合する: `reportFromAudit` と UI の audit 一覧が `state.json` を読んでいるので、今回は動かさない（#64）
- **Why chosen**: LogTape は依存が無く、同期の file sink とローテーション、`AsyncLocalStorage` による context を持つ。既定動作の問題はすべて設定で打ち消せることをソースで確かめた。`src/log.mts` に閉じ込めておけば、後から乗り換えるコストは 1 ファイル分で済む。
- **Consequences**:
  - 1 イベントごとに `fsync` が走る（`bufferSize: 0`）
  - `level` は `WARN` と表記される（`WARNING` ではない）
  - 新しいイベントを足すときは、この文書の語彙と漏洩防止の規則に従う。生の Error、ユーザー入力、秘匿値を props に入れない
  - `server.log` には warning 以上の構造化ログが入る
- **Follow-ups**:
  - `server.log` に上限を設ける。`mcp.mts` が fd を子プロセスに渡しているので、子プロセスの側ではローテーションできない
  - audit を `audit.jsonl` に移す（#64）
  - 障害対応で足りなかった情報を計装に戻す

## 8. 試験

| 試験 | 確かめること | 場所 | Issue |
|---|---|---|---|
| T6 | `setupLogging` した子プロセスの stdout が 0 バイトで、stderr には warning 以上だけが出る | `test/log.mts` | #77 |
| T7 | `maxSize` を 10000 に縮めて 1000 件書くと、`logs/` のファイル数が `maxFiles + 1` 以下で、全行が JSON | `test/log.mts` | #77 |
| T8 | `info('x', { message: 'y' })` で `message === 'x'`、`x_message === 'y'` | `test/log.mts` | #77 |
| T8b | `level === 'WARN'`、不正なレベルで落ちない、存在しない dir に `logs/` を作る、shutdown 後の呼び出しで例外にならない | `test/log.mts` | #77 |
| T9a〜T12 | 統合試験での `director.jsonl` の形、`server.log` の中身、MCP の stdout、SIGTERM 後の最終行 | `test/integration.mts` | #78 |
| T9c, T10, T10b | `http.request` の必須フィールドと `reqId` の一意性、`agentToken` と PAIR が 0 件 | `test/integration.mts` | #79 |
| T3, T4, T5, T5b | 全イベントの `service` / `component`、指示文が出ないこと、`cancelled.jobId`、`checkKind` | `test/director.mts` | #80 |
| T1, T2, T5c, T5d | `job.end` の失敗原因、キャンセルの相関キーと 1 回だけ書くこと、Refusal で `job_failed` を出さないこと。ほかに `agentRender` の記録と、リクエストから始まったジョブの `reqId` | `test/director.mts` | #81 |
