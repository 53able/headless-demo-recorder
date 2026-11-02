---
name: headless-demo-recorder
description: ブラウザや macOS アプリをヘッドレスで操作しながら録画し、ズーム・カーソル・字幕・ぼかしを付けた MP4/GIF のデモ動画を人手を介さずに作る。録画を開いたまま画面を観察して次の操作を1手ずつ決めることも、複数のエージェントがそれぞれの録画を同時に操作して1本に結合することも、録画済みの動画に後から編集を足すこともできる。Use when the user asks for a demo, walkthrough, or screen-recording video of a web page or a macOS app, wants agents to operate apps while being recorded, or wants zoom/captions/blur added to an existing screen recording. Don't use for live screen sharing, manual GUI video editing, physical mouse/drag input, or recording outside macOS.
---

# headless-demo-recorder

「Xのサインアップを20秒で見せるデモを作って」といった依頼を、人がエディタを触らずに MP4/GIF まで仕上げる。各コマンドは stdout に JSON を1つだけ出力する。

## 前提（Codex / Claude Code 共通）

- コマンドは `bun <skill-dir>/scripts/cli.ts <command>` で呼ぶ。`<skill-dir>` は、Claude Code / Codex がこのスキルを読み込むときに示す base directory（この SKILL.md があるディレクトリ）を指す。
- base directory が示されなければ、次の順に `scripts/cli.ts` があるディレクトリを `<skill-dir>` とする。プロジェクトへの導入（`npx skills add`）では `.claude/skills/headless-demo-recorder`、`.agents/skills/headless-demo-recorder`。ユーザー全体への導入（`npx skills add -g`）では `~/.claude/skills/headless-demo-recorder`、`~/.agents/skills/headless-demo-recorder`。
- どこにも無い、または `bun` が無い場合は止めて、利用者に導入を案内する（`npx skills add 53able/headless-demo-recorder -g -a claude-code -a codex`、bun は別途導入）。コマンドやフラグが `unknown command` になるなど、スキルが古いと思われる場合は `npx skills update headless-demo-recorder` を案内する。スキルの導入と更新は利用者が行う。
- シナリオと出力は、いま作業しているプロジェクトに置く（例: `scenarios/<name>.json`、`out/<name>.mp4`）。シナリオ内のパス（`output.path`、file ソースの `path`、composition の `scenarios[]`）は実行時のカレントディレクトリからの相対で解決される。録画には画面がそのまま入るので、出力先が `.gitignore` に入っていなければ利用者に伝える。
- 入力 JSON の形式は `<skill-dir>/scripts/types.ts`、例のシナリオは `<skill-dir>/assets/*.json` にある。`schema` を実行すると、型定義の全文、この文書のパス（`guide`）、例のパス（`examples`）を1つの JSON で返す。返るパスは symlink を解決した実体のパスであり、`<skill-dir>` の表記と一致しないことがある。
- 同梱の example は、このスキルの開発リポジトリのルートを cwd にした雛形。導入先ではそのまま `check` / `run` せず、作業中のプロジェクトに写して書き換える（特に composition の `scenarios[]` のパス）。
- `scripts/` の `*.test.ts` はスキルの開発用で、使うときは実行しない。導入先（`.agents/skills/` などドットで始まるディレクトリ）は、利用者のプロジェクトの `bun test` の探索対象に入らない。
- macOS の画面収録とアクセシビリティの権限は、エージェントを動かしているターミナルアプリに付与されている必要がある。付与は利用者が行う。
- Codex のサンドボックス（`workspace-write`）では、次のコマンドを**最初から**サンドボックス外で実行する許可を求める。サンドボックス内で試さない。
  - `doctor`、`render`、`run`: `openscreen` CLI の実体は Electron アプリで、サンドボックス内で起動するとウィンドウサーバーへの登録を拒否されてクラッシュする（実測）。そのたびに macOS のクラッシュレポートが作られ、利用者の画面にダイアログが出る。
    - サンドボックス内の `doctor` は、`openscreen CLI` に加えて `permissions` の項目も `Operation not permitted` で失敗する。権限の未付与ではない。
    - サンドボックス内の `render` は、空のメッセージの `PROJECT_INVALID` を返す。`hint`（capture.mp4 の配置）に従って再試行しない。
  - browser / desktop の `capture` と、下見の `agent-browser` / `agent-desktop`: ブラウザやアプリの起動とネットワーク接続を伴う。file ソースの `capture` はサンドボックス内で動くが、続く書き出しに `openscreen` が要るので、`run` はサンドボックス外で実行する。
  - `session` の各サブコマンド: `start` はブラウザ・アプリ・録画を起動する。`observe` / `act` / `status` / `stop` は一時ディレクトリの Unix ソケットで録画中のプロセスと通信する。すべてサンドボックス外で実行する（サンドボックス内では未実測）。
  - `check`、`plan`、`inspect`、`schema` はサンドボックス内で動く（実測）。
- 録画中の進み具合（録画の開始、各手の番号・経過時間・字幕、失敗した手、停止）は stderr に出る。`session` では録画を持つプロセスのログ `<project-dir>/session/server.log` に出る。`fill` の入力値は出さない。
- `inspectSheet` は PNG 画像。画像を読めるツール（Claude Code の Read、Codex の view_image など）で開いて確認する。

## コマンドとリスク

| コマンド | リスク | 効果 |
|---|---|---|
| `doctor` | R0 | 読み取りのみ。ツール、バージョン、OS権限を確認する |
| `schema` | R0 | 入力 JSON の型定義、この文書、例のシナリオの場所を返す |
| `check <scenario>` | R0 | シナリオを検証する。何も起動しない |
| `plan <project-dir> [--edit e.json]` | R0 | `render` が書き込む編集領域を表示する |
| `inspect <project-dir> [--video f]` | R0 | アクションごとに1コマ並べたコンタクトシートを作る |
| `render <project-dir> [--scenario s \| --edit e] [--out f]` | R1 | プロジェクトと出力ファイルを再生成する。既存の出力は `--force` がない限り上書きしない |
| `capture <scenario>` | R2 | アプリまたはページを起動・操作し、録画する |
| `run <scenario>` | R2 | check → capture → render → inspect を順に実行する |
| `session start <scenario> [--group g] [--idle-timeout 秒]` | R2 | 録画を開始して開いたままにする（browser / desktop）。シナリオの `steps` があれば先に実行する |
| `session observe <project-dir> [--screenshot]` | R0 | 録画中の画面のアクセシビリティスナップショット（`act` で使える参照付き）を返す。`--screenshot` で PNG も保存する |
| `session act <project-dir> '<step JSON>'` | R2 | 1手だけ実行する。シナリオの手と同じ検証（不可逆な操作、`--allow-origin`）を通る |
| `session status <project-dir>` | R0 | 録画中・停止済み・失敗、経過時間、記録した操作数を返す |
| `session stop <project-dir>` | R1 | 録画を止め、通常のプロジェクト（`capture.mp4`、`events.json`）として保存する |

## 作業ループ

1. `doctor` を実行する（Codex ではサンドボックス外で）。`ok:false` の項目があれば止めて、その `fix` を利用者に伝える。browser / desktop を録画する場合、権限が `granted` でなければ止めて、利用者に付与を依頼する。OS の設定やツールの導入を自分で行わない。file ソース（下記）だけを扱う場合、権限の項目は不要で、ツールの項目（ffmpeg、ffprobe、openscreen、openscreen CLI）が ok なら続けてよい。
2. **録画せずに下見する。** 先に、安定して指せる操作対象を見つける（file ソースでは不要）。
   - ブラウザ:
     1. `agent-browser --session explore open <url>` を実行し、続けて `agent-browser --session explore snapshot -i` を実行する。
     2. 対象は CSS・id・テキストのセレクタで指定する。`@eN` 参照は録画用のセッションに引き継がれず、`check` でも拒否される。
     3. 終わったら `agent-browser --session explore close` を実行する。
   - デスクトップ:
     1. 最初に一度だけ `agent-desktop skills get desktop` を実行する。
     2. `agent-desktop launch <App>` を実行し、続けて `agent-desktop snapshot --app <ローカライズ名> -i --compact` を実行する。ローカライズ名は `launch` の結果から取る（例: `Calculator` → `計算機`）。
     3. 対象は `find` のクエリで指定する（例: `{ "role": "button", "name": "7", "exact": true }`）。
3. `scenarios/<name>.json` を書く（形式は `scripts/types.ts` の `Scenario`。例は `assets/` のファイル）。字幕には「何をクリックしたか」ではなく「なぜそうするのか」を書く。秘密情報の入力欄には `"redact": true` を付ける。`check` が `ok:true` を返すまで直す。
4. `run scenarios/<name>.json` を実行する。
5. **`inspectSheet` を開いて目で確認する。** 書き出しに成功しても、動画の中身が正しいとは限らない。各コマについて、次の4点を確かめる。
   - 操作した要素が映っている。
   - カーソルがその要素の上にある。
   - 字幕が読める。
   - 個人情報が映っていない。
6. 修正は再録画せずに行う。`events.json`（タイミング、字幕、座標）またはシナリオの `edit` を直し、`render <project-dir> --scenario <file> --force` で再生成してから、もう一度 `inspect` する。

## 操作の種類

`steps` と `session act` の手は同じ形式で、`scripts/types.ts` の `Step` に従う。

- `click` / `fill` / `select`（ドロップダウンやリストから `value` を選ぶ）は `target` を取る。
- `scroll`:
  - ブラウザではページ全体を `px` だけ動かす。`target` は付けない。
  - デスクトップでは `target` の要素を `max(1, round(px / 100))` 単位だけ動かす。`target` は必須で、`direction` は `up` / `down` / `left` / `right` を使う。
    - WebView のアプリ（Tauri / Pake / Electron など）では、`{ "role": "scrollarea" }` のような role だけのクエリが、ページ内の多数の要素に当たって失敗しやすい。`session observe` で得たスクロール領域の参照を使う。
    - WebKit のなめらかなスクロールは、操作の 350ms 後には終わっていないことがある。`inspectSheet` のスクロールのコマが途中の位置を映していても、録画の後半で行き着いているかを確かめる。
- `press`（キー）、`wait`（ミリ秒）、`mark`（字幕だけ）はどちらでも使える。`open`（URL を開く）はブラウザ専用。
- ドラッグ、ホバー、座標指定のクリックは扱わない。agent-desktop ではこれらが `--headed`（物理入力）を要するため。
- 1つの録画は1つのウィンドウ（desktop）または1つのページ（browser）だけを映す。複数のアプリを1本に入れるときは、アプリごとに録画して composition で並べる。
- browser で新しいタブを開く手（`target="_blank"` のリンクなど）は録画されない。そのような手は、開いたタブを閉じて録画中のタブに戻したうえで、`NEW_TAB` を含むエラーで失敗する。遷移先は `open` で同じタブに開く。
  - `--allow-origin` を指定していると、agent-browser 0.41.1 は新しいタブを開くクリックに応答を返さず、ページが `about:blank` になる（実測）。この状態からは戻せない。新しいタブを開くリンクは押さず、遷移先の URL を `open` で開く。セッションでこうなった場合は `session stop` して始め直す。

## 録画中に画面を見ながら進める（session）

手順を事前に決め切れない場合は `session` を使う。例えば、画面の内容によって次の操作が変わる場合や、想定外のダイアログに対応する場合がこれに当たる。録画を開いたまま、観察と1手の操作を繰り返す。

1. 作業ループの1〜3と同じく、`doctor` を確かめてシナリオを書く。`steps` は空でよい。録画開始直後に必ず行う操作（初期化など）だけを `steps` に入れる。`check` を通す。
2. `session start <scenario> [--allow-origin …] [--allow-app …]` を実行する。`ok:true` と `status: "recording"` が返ったら録画中になっている。
3. 次の a〜c を繰り返す。
   a. `session observe <project-dir>` で画面を見る。
      - ブラウザでは `snapshot.refs` のキー `eN` に `@` を付けた `@eN`（`eN`、`ref=eN` も同じ扱い）が、デスクトップでは `snapshot.tree` の `ref_id`（`@<snapshot_id>:eN`）がそのまま、`act` の `target` に使える。
      - 使えるのは、このセッションの**直近の** `observe` が返した参照だけ。1手実行するたびに参照は無効になるので、参照で指す手の前には毎回 `observe` する。別のアプリの参照、古い参照は `INVALID_STEP` で拒否される。
      - 参照が指す要素の名前（例: `button Delete account`）は、観察した時点のものが不可逆な操作の検証にかかる。セレクタや find クエリで指した場合に検証されるのは、書いた文字列だけ（要素の実際の名前は見ない）。名前で確かめたい操作は、観察した参照で指す。
      - 見た目で判断する必要があるときは `--screenshot` を付け、返る `screenshot` の PNG を開く。
   b. 次の1手を決めて、`session act <project-dir> '<step JSON>'` を実行する。字幕には、その手を打つ理由を書く。
   c. 返答を読む。
      - `ok:true`: 次の観察へ進む。
      - `INVALID_STEP`: 何も実行されていない。手を直す。
      - `RECORDER_DIED`（`retry: no`）: 録画が勝手に終わった（ウィンドウが閉じた、クラッシュなど）。それまでの録画は保存処理に回る。`session status` で結果を確かめ、アプリの状態を見てから `session start --force` で始め直す。
      - それ以外の `ok:false`（`TARGET_NOT_FOUND` など）: 録画は続いており、失敗した手はログから外れている。もう一度 `observe` してから次の手を選ぶ。再録画しない。
4. 終わったら必ず `session stop <project-dir>` を実行する。録画中のプロセスを残さない。
5. 返る `next` に従って `render <project-dir> --scenario <scenario> --force` を実行し、作業ループの5〜6（`inspect` と目視確認）を行う。

- 考えている時間もそのまま録画に入る。`edit.idleSpeedupMs`（例: 1500）で、操作のない区間を早送りする。
- 手は1つずつ順に実行される。セッション内では `wait` の `ms` と各手の `waitMs` は 60000 まで。`session status` は手の実行中でも答える（`busy: true`）。
- 最後の要求が終わってから `--idle-timeout` 秒（既定 600）が経つと、録画は自動で停止・保存される。手の実行中には止まらない。
- `session status` が `failed` を返したら、返る `log`（サーバのログ）を読む。開始に失敗した場合（`SESSION_START_FAILED`、`retry: no`）は、アプリやブラウザの状態を確かめてから `session start --force` で始め直す。
- 1つの project を録画できるのは1本だけ。録画中は、同じ project への `session start` / `capture` / `run` が `SESSION_ACTIVE` で止まる。

### 複数のエージェントで同時に録る

1. エージェントごとに別のシナリオ（別の `name` と `output.path`）を用意する。そのうえで、すべてのセッションを同じ `--group <名前>` で続けて開始する。
2. 各エージェント（サブエージェントなど）は、自分の project だけに対して `observe` / `act` を繰り返す。互いの手を待ち合わせる仕組みはない。
3. 全員が終わったら、各 project を `session stop` する。
4. それらのシナリオを参照する composition を書き、`render <compProj> --composition <c.json> --force` で結合する。続けて `inspect` する。
   - 同じ group のセッションは開始時刻が揃えられる。後に始まった録画の開始時点が、結合後の先頭になる。
   - 揃えるのは、開始時刻の差が10分以内の場合だけ。同じ group 名を別の日に使い回した録画は揃えない。録り直すときは、全員分を同時に始め直す。
5. 同じアプリを2つのセッションで操作しない。desktop の入力は同じウィンドウに届くため。

## file ソース（既存の動画を編集する）

録画済みの動画（QuickTime、OBS、以前の `capture.mp4` など）に、ズーム・カーソル・字幕を付けて書き出す。ブラウザも対象アプリも起動しない。`run` を使ってよく、その capture 段階は ffmpeg による変換だけを行う（書き出しには `openscreen` を使うので、Codex ではサンドボックス外での実行が要る）。

- `source`: `{ "type": "file", "path": "<動画>", "events": "<操作ログ>" }`。`events` は省略できる（その場合、ズーム・カーソル・字幕は付かない）。パスは実行時のカレントディレクトリからの相対で解決される。
- 操作ログは `ActionEvent` の配列（`scripts/types.ts`）。座標はすべて動画のフレームに対する 0〜1 の比率で表す。
  - `tMs`（必須）: 動画上の時刻（ミリ秒）
  - `kind`（必須）: `click` / `type` / `press` / `scroll` / `navigate` / `wait` / `mark`
  - `point`: 操作した点 `{cx, cy}`（`{x, y}` ではない。ピクセル値ではなく比率）。`point` を持つ `click` / `type` がズームの中心になり、`point` を持つイベントにカーソルが動く
  - `rect`: 対象要素の矩形 `{x, y, w, h}`。ぼかし専用（`redact: true` と組で使う。`rect` の無い `redact` は効かない）
  - `caption`（字幕の文字列）、`zoom`（false でそのイベントをズームしない）、`redact`
- `check` は操作ログの形式も検証する。ログの中身（ラベルや座標）が動画に映っているものと合っているかは検証しないので、作業ループ5の目視確認で確かめる。

書き出した動画は OpenScreen が余白と背景を付けるため、解像度とフレームレートが入力と一致しない（例: 1280x720・30fps の入力から 1784x1080・60fps の出力）。サイズが重要なら `ffprobe` で出力を確かめる。

## 複数の録画を同時に行い、1本に結合する（composition）

既存のシナリオを 1〜2 本参照する構成ファイル（スキーマは `scripts/types.ts` の `Composition`、例は `assets/composition-calc-wiki.json`）を書き、`check` → `run` → `inspect` は単一シナリオと同じ手順で行う。

1. 参照先のシナリオは先に単体で `check` を通し、下見を済ませておく。`check <composition>` は参照先の検証も含めて1つの JSON で返す。
2. `--allow-origin` / `--allow-app` は参照先すべてに掛かる。desktop を2本録るなら両方のアプリを列挙する。
3. 参照先は同時に録画を開始し、あとは独立に進む。ステップ単位の待ち合わせ（A の操作を B が待つ）はできない。
4. `inspectSheet` では、各場面の切り替わり（`events.json` の `scene N:` の mark）と、左右それぞれのセルに字幕とカーソルが出ていることを確かめる。
5. 修正は参照先の `events.json` か composition の `scenes` / `edit` を直し、`render <compProj> --composition <file> --force` で結合だけをやり直す。

- `CAPTURE_PARTIAL_FAILED`（`retry: no`）のときは、アプリの状態を戻してから `run <composition> --force` で全本を撮り直す。別の実行で撮った録画は開始時刻を揃えられない（`runId` が違う）ので、1本だけ撮り直して結合しない。
- composition の `output.path` は、既存の単一シナリオの project と重ねない。重なると `PROJECT_COLLISION` で止まる。

## 失敗時の対応: まず `retry` を読む

Codex で `doctor` の権限項目が `Operation not permitted`、または `render` が空のメッセージの `PROJECT_INVALID` になったら、まずサンドボックス内で実行していないかを疑う（前提の節を参照）。

- `safe`: 何も起きていない。そのまま再実行してよい。
- `after-fix`: `hint` が示す箇所を直してから再実行する。`render` 段階で失敗した場合は録画が残っているので、`artifacts.retryWith` のコマンドで書き出しだけをやり直せる。
- `no`: 実アプリまたはページでステップが途中まで実行されている（録画中の `TARGET_NOT_FOUND` など）。次の順で対応し、再試行を繰り返さない。
  1. アプリの状態を確認し、元に戻す。
  2. 失敗したステップの画面をもう一度下見する。
  3. ここまで済んでから `capture --force` を実行する。

## ガードレール

- `check` は、対象の名前が不可逆な操作に見えるステップを拒否する（delete、send、purchase、削除、送信など）。
  - 確認したうえで無害なステップ（計算機の「すべて消去」など）は、**そのステップに** `"allowDestructive": true` を付ける。
  - シナリオ全体に付ける `allowDestructive` は、実際にその操作を行うデモに限る。必ず利用者の承認を得てから使う。
  - 判定は単語リストによる推定にすぎない。`check` を通過しても、そのステップが安全だとは保証されない。
- agent-desktop はヘッドレスで動く。利用者が物理入力を許可しない限り、`--headed` を付けない。
- デスクトップ録画は実際のウィンドウを録る。上に重なった通知も映り込む。
- `openscreen` をサブコマンドなし、または `--version` 付きで実行しない。GUI が起動する。`doctor` は `openscreen help` を使う。
- `openscreen export --auto-zoom` は、ヘッドレス実行では効かない。ズームは操作ログから生成する。
- `session act` でも不可逆な操作の検証は変わらない。拒否された手は実行しない。`allowDestructive` を手に付けるのは、無害だと確かめた場合に限る。
  - 検証は語リストによる推定で、見るのは参照の名前（観察時点）か、セレクタ・クエリに書いた文字列だけ。観察のあとに画面が自分で書き換わった場合や、`select` で option の value 属性（表示名と異なる）を指定した場合は検出できない。
