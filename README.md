# Render Director

vork で描画するエージェントのための、非公式のレビュー画面です。

本プロジェクトは独立した非公式の連携ツールです。Voyager / Nullframe が提供・承認する製品ではなく、同社との提携関係もありません。

[vork](https://github.com/voyager-so/vork)（エージェント向けのヘッドレス3D/VFXエンジン）で作ったビジュアルを、人間がレビューして採用するためのローカルWebアプリです。

vork 本体は同梱していません。別途インストールし、[vork のライセンス](https://github.com/voyager-so/vork/blob/09dbd97a8601dbbd5870dc5a2856aa59d7ea21dd/LICENSE)に従って利用してください。vork は独自ライセンスの source-available ソフトウェアであり、改変版の配布やホスト型レンダリングサービスの提供には事前の書面許可が必要です。本リポジトリの公開は、vork や依存パッケージのライセンスを変更するものではありません。

モードは2つあります。

- **ADEモード**: Claude Code や Codex などのエージェントが、MCP経由でシーンを書き、描画を見て直します。人間は Director で候補を比較し、画像を指してフィードバックを返し、採否を決めます。採用した画像とシーンはプロジェクトに書き戻されます。
- **単独モード**: Director に内蔵したエージェント（`claude -p`、ツールなし）に日本語で指示します。

![ADEモード: 候補を開発中のページに当てはめて比較](docs/screenshot-on-page.png)

初めて使うときは [クイックガイド](docs/quick-guide.md) から始めてください。同梱のサンプルページで、提案の確認から画像の採用までを一通り試せます。

## 必要なもの

- vork 0.1.0（Apple Silicon + macOS 26以降、またはNVIDIA RTX + Vulkan）
- Node.js 22.18以降（`.mts` を型除去でそのまま実行する）
- ページプレビューに Google Chrome（`CHROME_PATH` で変更可）
- 単独モードに Claude Code CLI（`claude`、ログイン済み）

```sh
npm install
```

## ADEモード

### 1. MCP を登録する

プロジェクトのルートで登録します。`/path/to/render-director` は、このリポジトリを clone した場所に置き換えてください。Director はエージェントが最初にツールを呼んだときに自動で起動し、状態を `<project>/.vork/` に保存します。

**Claude Code**

```sh
claude mcp add vork -- node /path/to/render-director/mcp.mjs --project .
```

**Codex**（`~/.codex/config.toml`）

```toml
[mcp_servers.vork]
command = "node"
args = ["/path/to/render-director/mcp.mjs", "--project", "/path/to/your/project"]
startup_timeout_sec = 30
tool_timeout_sec = 300
default_tools_approval_mode = "approve"   # 無いと承認ポリシーによってはツール呼び出しが拒否される
```

動作確認の範囲:

- Claude Code 2.1.319: 上のコマンドで登録すると `claude mcp list` が Connected を表示した。`--mcp-config` で一時登録した状態で、`get_render` の画像の内容をエージェントが説明できた。
- Codex CLI 0.167.0: `-c mcp_servers.vork.*` で上の設定と同じ値を一時的に指定し、同じ確認をした。`config.toml` への恒久的な書き込みは試していない。

### 2. エージェントに頼む

例: 「このページのヒーロー画像を vork で作って。Director で私に確認してから採用を依頼して」

エージェントが使うツール:

| ツール | 内容 |
|---|---|
| `director_status` | 人間が開くURL、HEAD、版の一覧 |
| `vork_help` | vork のドキュメント |
| `get_scene` | 版のシーンJSON |
| `propose_scene` | シーンを提案する。シーンは引数 `scene` か、プロジェクト内の JSON ファイル `scene_file`（スクリプトで作った大きなシーン向け）で渡す。ポリシー検査とvork検証を通ると `proposed` の版になり、draft画像が返る。HEADは動かない |
| `get_render` | 版の画像（MCPのimageコンテンツ）と露出・オブジェクトID |
| `wait_for_feedback` | 人間のフィードバック、採否、直接編集、採用結果を待つ（最大120秒） |
| `request_adoption` | 採用を依頼する。書き込むのは人間が承認したときだけ |

採否、final描画の承認、書き戻しの承認を行うMCPツールはありません（`open_review_tab` は人間のブラウザにレビュー用タブを開くだけです）。

### 3. Director で見る

Director は起動時に、ブラウザでレビュー用のタブを開きます。このタブは1回限りのペアリングリンク（URLの `#pair=...`）で Director と結び付きます。URL（既定 http://127.0.0.1:4747 。使用中なら次の番号）を直接開いただけのタブでは何も操作できません。タブを閉じてしまったら、エージェントに `open_review_tab` を頼むか、Director のプロセスに `kill -USR1 <pid>` を送ると新しいタブが開きます。Director を端末で直接起動した場合は、ペアリングリンクが端末に表示されます。

既定のブラウザ以外で開くには、環境変数 `RENDER_DIRECTOR_BROWSER` にブラウザを開くコマンドを指定します。値は実行ファイル1つか、文字列の JSON 配列です。リンクは最後の引数として渡されます。MCP から起動する Director には、MCP の登録時に渡します（例: `claude mcp add vork -e 'RENDER_DIRECTOR_BROWSER=["open","-a","Firefox"]' -- node /path/to/render-director/mcp.mjs --project .`）。`.vork/config.json` では指定できません（エージェントが書き換えられるため、リンクがエージェントに渡る経路になる）。リンクはコマンドの引数として渡るので、そのプロセスが動いている間は `ps` で見えます。起動後すぐ終わるコマンド（`open` など）を使ってください。自動操作のブラウザを起動するスクリプトのように常駐するコマンドを使うときは、`RENDER_DIRECTOR_BROWSER_STDIN=1` も指定します。リンクは引数ではなく、末尾に改行を付けた1行として標準入力に渡ります。

- エージェントの新しい提案は通知されます。「View」で開き、親の版とワイプで比べられます。見ている版が勝手に切り替わることはありません。別のタブを見ている間は、タブのタイトルに `(1)` が付きます。ブラウザは隠れたタブのタイマーを間引くので、印が付くまでに表示中のタブ（2.5秒ごと）より時間がかかることがあります（Chrome では最大1分程度）。
- 「Discard」は6秒間「Undo」で取り消せます。その間はエージェントに何も届かず、時間が来たときに破棄が確定します（その前にタブを閉じると破棄されません）。採用済みでHEADでない版には「Make HEAD」が出て、HEADを戻せます（Accept の取り消し）。
- 物体をクリックして選び、コメントを「Send to agent」で送ります。エージェントが読んだかどうかが表示されます。
- 「On page」で、開発中のページに候補を当てはめた状態を見られます。プロジェクトのファイルは変えません。
- 採用依頼が来たら「Review…」で書き込み先と上書きの有無を確認して承認します。ダイアログには書き込む画像（final 描画がまだなら draft。書き込む前に final で描き直す）と、上書きされる既存の画像が並びます。承認は表示した既存ファイルにも結び付き、承認後にそのファイルが変わったら書き込みを中止します。採用の処理中は「adopting…」と表示され、却下やその版の破棄はできません。止めるにはジョブを取り消します（依頼は保留に戻ります）。保留中の依頼の版を破棄すると、その依頼は自動で却下され、エージェントには `adoption_rejected`（comment: `version discarded`）が届きます。

### 設定（`<project>/.vork/config.json`）

```json
{
  "assetDir": "public/vork",
  "pageUrl": "http://127.0.0.1:5173/",
  "assetUrlPattern": "**/vork/hero.png"
}
```

`assetUrlPattern` は Playwright の URL パターンです。CSS背景画像や画像最適化URLを使う構成では、実際に読み込まれるURLに合わせてください。差し替えが0件なら画面に警告が出ます。

### 採用されたもの

- `<assetDir>/<slug>.png`: final品質の画像
- `.vork/adopted/<slug>.json`: シーン、シーンハッシュ、vork版、プロファイル、採用理由、PNGのsha256。後日の修正や再生成に使えます

`.vork/` の中は `config.json` と `adopted/` 以外が gitignore されます。

## 単独モード

```sh
node server.mts             # http://127.0.0.1:4747 、状態は runs/
```

## 試験と計測

```sh
npm run typecheck           # TypeScript 7 で型検査（サーバー側 .mts と public/app.js の JSDoc）
npm test                    # test:unit + 統合試験（実MCPクライアント、vork が必要）
npm run test:unit           # 自己テスト（ポリシー、差分、書き込み先の検査）、Director の use case、レビュー画面の照合（public/review-model.js）。vork も Chrome も不要
npm run test:e2e            # ブラウザE2E（Chrome）。E2E_AGENT=1 で内蔵エージェントも試す。E2E_REQUIRED=1 なら Chrome が無いと失敗にする。README の画像（docs/screenshot-*.png）は E2E_UPDATE_SCREENSHOTS=1 のときだけ書き換える
npm run report -- <project> # 最初の提案から採用までの時間、フィードバック回数など
```

同じ GPU で複数の vork が同時に描画すると `GPU device lost` で失敗することがあります。そのため Director は、vork で描画するたびに `os.tmpdir()` のロックファイル（`render-director-vork.lock`）を取り、同じマシンのほかの Director の描画が終わるまで待ちます（待ち時間は描画の上限時間に含めません）。vork を使う試験（`npm test` の統合試験と `npm run test:e2e`）は、加えて開始時に `render-director-gpu-test.lock` を取り、試験を1本ずつ流します。Director を通さない vork の描画との同時実行は防げません。その失敗は画面に「GPU was busy … render again」と出るので、描画をやり直してください。

実験の手順は [docs/experiment.md](docs/experiment.md)、設計判断とリスクは [docs/ai-interface-design.md](docs/ai-interface-design.md) にあります。サンプルのページは [examples/landing](examples/landing) です。

## 安全境界

- エージェントが出したシーンと人間の直接編集は、サーバー側のポリシーを通過したものだけがvorkへ渡ります。遮断するもの: 絶対パス・`..`・URLのファイル参照、`.glb` と画像以外のファイル、カスタムSlangプログラム、1920×1080を超える `resolution`、名前の重複。
- サーバーは127.0.0.1だけで待ち受け、Hostヘッダー、Origin、`application/json` を検査します。
- 書き戻し先はプロジェクトの内側に限ります（`..`、絶対パス、外へ向くシンボリックリンクを拒否）。
- 人間用のAPIと描画ファイルは、ペアリング済みのブラウザセッション（HttpOnly、SameSite=Strict のCookie）でしか使えません。ペアリング用トークンは、Director からOSのブラウザ起動コマンドへ渡すだけで、ファイルにもログにも書きません。エージェント用のトークン（`.vork/server.json`）では人間用APIは403になります。
- 起動中の Director に新しいペアリング用リンクを発行させて端末に表示するコマンドは、用意していません。端末のコマンドが Director に届く経路は、同じユーザーで動くエージェントも使えるので、エージェントがそのコマンドを1回呼ぶだけでリンクを得られてしまうためです。リンクを得る方法は、ブラウザで開く（既定のブラウザか `RENDER_DIRECTOR_BROWSER`。`kill -USR1` も同じ）と、Director を端末で直接起動したときの表示の2つです。
- 書き戻しの承認は、そのときのシーン本文、書き込み先、上書きの有無に結び付きます。承認後にシーンや `config.json` が変わったら書き込みを中止します。
- **これは同じユーザー権限で動くエージェントへの強制力を持ちません。** シェルを持つエージェントは、`.vork/state.json` を直接書き換える、プロセスの引数を覗く、ファイルを直接置く、といった方法で回避できます。境界が防ぐのは、エージェントが通常の手順として承認を代行することです。強制が必要なら、ADE側のサンドボックス（書き込み先やプロセスの制限）と組み合わせてください。manifest もエージェントが書けるので、改ざんの証明にはなりません。
- vork 自体はサンドボックス化していません。

## ライセンス

[MIT License](LICENSE)。この条件は本リポジトリのコードにのみ適用されます。vork 本体と依存パッケージは、それぞれのライセンスに従います。
