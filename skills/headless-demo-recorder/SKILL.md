---
name: headless-demo-recorder
description: ブラウザや macOS アプリをヘッドレスで操作しながら録画し、ズーム・カーソル・字幕・ぼかしを付けた MP4/GIF のデモ動画を人手を介さずに作る。複数の録画を同時に撮って1本に結合したり、録画済みの動画に後から編集を足したりもできる。Use when the user asks for a demo, walkthrough, or screen-recording video of a web page or a macOS app, or wants zoom/captions/blur added to an existing screen recording. Don't use for live screen sharing, manual GUI video editing, or recording outside macOS.
---

# headless-demo-recorder

「Xのサインアップを20秒で見せるデモを作って」といった依頼を、人がエディタを触らずに MP4/GIF まで仕上げる。各コマンドは stdout に JSON を1つだけ出力する。

## 前提（Codex / Claude Code 共通）

- コマンドは `bun <skill-dir>/scripts/cli.ts <command>` で呼ぶ。`<skill-dir>` は、Claude Code / Codex がこのスキルを読み込むときに示す base directory（この SKILL.md があるディレクトリ）を指す。
- base directory が示されなければ `~/.codex/skills/headless-demo-recorder` または `~/.claude/skills/headless-demo-recorder` を `<skill-dir>` とする。
- シナリオと出力は、いま作業しているプロジェクトに置く（例: `scenarios/<name>.json`、`out/<name>.mp4`）。シナリオ内のパス（`output.path`、file ソースの `path`、composition の `scenarios[]`）は実行時のカレントディレクトリからの相対で解決される。録画には画面がそのまま入るので、出力先が `.gitignore` に入っていなければ利用者に伝える。
- 入力 JSON の形式は `<skill-dir>/scripts/types.ts`、例のシナリオは `<skill-dir>/assets/*.json` にある。`schema` を実行すると、型定義の全文、この文書のパス（`guide`）、例のパス（`examples`）を1つの JSON で返す。返るパスは symlink を解決した実体のパスであり、`<skill-dir>` の表記と一致しないことがある。
- 同梱の example はリポジトリルートを cwd にした雛形であり、コピー設置先ではそのまま `check` / `run` せず、自分のプロジェクトに写して書き換える。
- `scripts/` にはテスト（*.test.ts）も同居しており、設置先で `bun test` を走らせると実行される。
- macOS の画面収録とアクセシビリティの権限は、エージェントを動かしているターミナルアプリに付与されている必要がある。付与は利用者が行う。
- Codex のサンドボックス（`workspace-write`）では、次のコマンドを**最初から**サンドボックス外で実行する許可を求める。サンドボックス内で試さない。
  - `doctor`、`render`、`run`: `openscreen` CLI の実体は Electron アプリで、サンドボックス内で起動するとウィンドウサーバーへの登録を拒否されてクラッシュする（実測）。そのたびに macOS のクラッシュレポートが作られ、利用者の画面にダイアログが出る。
    - サンドボックス内の `doctor` は、`openscreen CLI` に加えて `permissions` の項目も `Operation not permitted` で失敗する。権限の未付与ではない。
    - サンドボックス内の `render` は、空のメッセージの `PROJECT_INVALID` を返す。`hint`（capture.mp4 の配置）に従って再試行しない。
  - browser / desktop の `capture` と、下見の `agent-browser` / `agent-desktop`: ブラウザやアプリの起動とネットワーク接続を伴う。file ソースの `capture` はサンドボックス内で動くが、続く書き出しに `openscreen` が要るので、`run` はサンドボックス外で実行する。
  - `check`、`plan`、`inspect`、`schema` はサンドボックス内で動く（実測）。
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
