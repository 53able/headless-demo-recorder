# headless-demo-recorder

エージェントが UI を操作している間の画面を録画する。そのあと、人の手を介さずに動画を編集・書き出しする。編集で加えるのは次の5つ。

- ズーム
- 動くカーソル
- 字幕
- 秘密情報のぼかし
- 待ち時間の早送り

```
scenario.json ─┬─ browser: agent-browser（操作 + WebM 録画 + 要素の矩形取得）
               ├─ desktop: agent-desktop（アクセシビリティ API で操作）+ openscreen record --window
               └─ file:    既存の任意の動画（+ 任意の events.json）
                     │
                     ▼  操作ログ: [{ tMs, kind, rect, point, caption, redact }]
               compile.ts ── zoomRegions / annotationRegions / speedRegions / 合成 cursor.json
                     │
                     ▼
               openscreen export（ヘッドレス）──▶ MP4 / GIF
```

## 操作ログを使う理由

OpenScreen の `--auto-zoom` は、実際のマウスクリックを手がかりにズームを付ける。agent-browser と agent-desktop はポインタを動かさずに操作するので、ヘッドレス実行ではクリックが記録されない。

そこで各アクションの実行時に、対象要素の矩形と動画上の時刻を記録する。`compile.ts` はこの操作ログから次のものを生成する。

- **ズーム**: 操作した要素を中心にズームする。近接したアクションは1つのズームにまとめ、ズーム同士が重ならないようにする。
- **合成カーソル**: `<video>.cursor.json` として書き出す。OpenScreen はこのファイルを動画の横に置かれた付随ファイルとして自動で読み込み、各要素へ滑らかに移動して時刻どおりにクリックするカーソルを描画する。
- **字幕**: `step.caption` の内容を、画面に固定したテキストとして表示する（`space: "frame"`）。ズームしても位置と大きさは変わらない。
- **ぼかし**: `redact: true` を付けた要素に適用する。
- **早送り**: `idleSpeedupMs` を超えて何も操作しない区間を早送りする。

## 必要環境

- macOS
- bun、ffmpeg
- `agent-browser`（0.41）、`agent-desktop`（1.0.2）
- OpenScreen 1.13 以上（`openscreen` CLI に PATH が通っていること）
  - macOS で PATH に通すときは、シンボリックリンクではなく実体を `exec` するスクリプトを置く（例: `printf '#!/bin/sh\nexec /Applications/Openscreen.app/Contents/MacOS/Openscreen "$@"\n'`）。シンボリックリンク経由だと `help` と `export` は動くが、`record` が `Renderer crashed` で失敗する（実測）。
- デスクトップ録画には、ターミナルへの画面収録とアクセシビリティの権限付与が必要

## 使い方

```bash
bun install && bun test
bun src/cli.ts doctor                                   # ツールと権限を確認（読み取りのみ）
bun src/cli.ts schema                                   # 入力 JSON の型定義・手順書・例の場所
bun src/cli.ts check scenarios/browser-wikipedia.json   # 検証のみ。何も起動しない
bun src/cli.ts run scenarios/browser-wikipedia.json     # capture → render → inspect
bun src/cli.ts render out/wikipedia-search.project --edit edit.json --out out/v2.mp4   # 再録画せずに再編集
bun src/cli.ts run scenarios/composition-calc-wiki.json --allow-app com.apple.calculator --allow-origin https://en.wikipedia.org   # 2本を同時に録画して1本に
```

### 複数の録画を同時に行い、1本に結合する（composition）

構成ファイルは既存のシナリオを参照し、どれを同時に録るか、どう並べるかだけを持つ。参照先の `Scenario` は変えない。

```json
{
  "name": "calc-wiki",
  "scenarios": ["scenarios/desktop-calculator.json", "scenarios/browser-wikipedia.json"],
  "scenes": [
    { "layout": "side-by-side", "streams": [{ "scenario": "calculator" }, { "scenario": "wikipedia-search" }] },
    { "layout": "single", "streams": [{ "scenario": "wikipedia-search" }] }
  ],
  "edit": { "titles": [{ "text": "2つの録画を1本に", "startMs": 0, "endMs": 1500 }] },
  "output": { "path": "out/calc-wiki.mp4", "quality": "good" }
}
```

- `scenarios` は 1〜2 本。参照先は同時に録画を開始する（開始時刻の差は結果 JSON の `startSkewMs`。実測 100〜400ms）。各録画は独立に進み、ステップ単位の待ち合わせはしない。
- `scenes` は順に再生される。`single` は1本を全面に、`side-by-side` は2本を左右に並べる。各 stream は `startMs` / `endMs`（揃えた後の録画上の時刻）で区間を切れる。
- 出力フレームは `size`（既定 1920x1080）。録画はセルに収まるよう縦横比を保って拡縮し、余白は暗色で埋める。
- ズーム・字幕・合成カーソルは各録画から引き継ぐ。ズームの設定と字幕の大きさは参照先の `scenario.edit` が既定値で、`composition.edit` の同名キーで上書きする。`titles` と `style` は composition のみ。`trim`・`idleSpeedupMs`・`speechCaptions`・plan レベルの `redact` は composition では使えない。
- ズームは出力全体に1つしか掛からない。左右並べで2本のズームの時刻が重なったときは、先に始まった方を採用し、後の方は捨てる。片方のセルにズームしている間、もう片方のセルはほぼ画面外に出る。
- 結果 JSON は単一シナリオと同じ形に `projectDirs`（参照先の project）と `startSkewMs` が加わる。合成後の project（`out/<name>.project/`）の `events.json` は派生物で、`render` のたびに上書きされる。手で直すのは参照先の `events.json`。
- 直すときは `render out/calc-wiki.project --composition scenarios/composition-calc-wiki.json --force`。参照先の録画はそのまま使う。
- 片方の録画が**録画開始前**に失敗すると、もう片方も開始前に止める（実アプリを片方だけ操作し続けない）。開始後の失敗では、終わった録画は残るが、別の実行で撮り直した録画とは開始時刻を揃えられない（`capture.json` の `runId` が違う録画は位置合わせせずに結合する）。`CAPTURE_PARTIAL_FAILED`（`retry: no`）のときは、アプリの状態を戻してから `run <composition> --force` で全本を撮り直す。
- 参照先の `scenario.edit` にある `trim` / `idleSpeedupMs` / `speechCaptions` / `redact` は composition では無視され、`check` が warning を出す。

`capture` は書き出しより先に、`out/<name>.project/` へ次の3つを保存する。

- `capture.mp4`
- `capture.json`
- `events.json`

書き出しに失敗したときや見た目を変えたいときは、同じプロジェクトに対して `render` を実行し直せばよい。`run` は目視確認用に、アクションごとに1コマ並べた `inspect-sheet.png` も出力する。

各コマンドは JSON を1つだけ出力する。失敗時の JSON には `stage`、`code`、`retry`（`safe` / `after-fix` / `no`）、`hint` が入る。

- エージェントの作業手順とガードレール: `AGENTS.md`
- 設計の根拠: `docs/tool-design-review.md`

## 説明動画を作り直す

`demo/howto/` は、このツールの使い方を見せる説明動画（`out/howto.mp4`）を、このツール自身で録画する手順である。ブラウザ上の端末で実際にコマンドを打ち、その画面を browser ソースで録画する。端末内では browser・desktop・file の3種類の `run` を実行する。

端末は [wterm](https://github.com/vercel-labs/wterm)（DOM で描画するウェブ端末）と、Bun の PTY（`Bun.spawn` の `terminal`）で動かす。`demo/howto/server.ts` が、端末、結果ページ（`/demo/`）、`out/` の配信を 127.0.0.1:7681 の1つのポートで受け持つ。

```bash
bun install --cwd demo/howto      # 初回のみ（@wterm/dom）。型検査は bun run --cwd demo/howto typecheck
bun demo/howto/server.ts &        # 127.0.0.1:7681
bun src/cli.ts run demo/howto/scenario.json --allow-origin http://127.0.0.1:7681 --force
kill %1
```

- 端末内の desktop 録画で計算機が起動するので、desktop 録画の権限が要る（`doctor` で確認する）。
- 端末の WebSocket は、`Origin` が `http://127.0.0.1:7681` の接続だけを受け付ける。書き込みできるシェルなので、普段のブラウザで開いている他のページからは操作できないようにしている。
- 録画される端末は、利用者の設定ではなく `demo/howto/zdotdir/.zshrc` で起動する。プロンプトにユーザー名やホームのパスは出ず、履歴も保存しない。
- 端末内の各コマンドは stderr を捨て、出力のパスを `out/` からの相対パスに直して表示する。絶対パスにはホームディレクトリが含まれるためである。
- 標準の Terminal.app を agent-desktop で操作する方法は取らない。`src/appguard.ts` の拒否リストが Terminal.app への入力を拒否するためである。

## Codex / Claude Code から使う

エージェントはシェルから `bun src/cli.ts <command>`（PATH に通したなら `headless-demo-recorder <command>`）を呼び、stdout の JSON を読んで次の手を決める。作業手順とガードレールの正本は `AGENTS.md` で、Codex はこれをそのまま読む。Claude Code は `CLAUDE.md`（中身は `@AGENTS.md` の1行）を経由して同じ内容を読む。

使う前に、次を利用者が済ませておく。

- 画面収録とアクセシビリティの権限を、エージェントを動かしているターミナルアプリ（Terminal、iTerm2、エディタ内蔵ターミナルなど）に付与する。`doctor` で確認できる。
- Codex のサンドボックスでは、`doctor`、`render`、`run`、`capture`、および下見の `agent-browser` / `agent-desktop` にサンドボックス外での実行の許可が要る。`openscreen` CLI の実体は Electron アプリで、サンドボックス内で起動するとクラッシュし、macOS のクラッシュダイアログが出る。`doctor` の権限の確認も `Operation not permitted` で失敗する（いずれも実測）。`check`、`plan`、`inspect` はサンドボックス内で動く（実測）。
- `inspectSheet` の目視確認には、画像を読めるモデルが要る。

### 別のプロジェクトから使う

1. コマンドを PATH に通す。`src/cli.ts` は `#!/usr/bin/env bun` で始まり、実行時の依存パッケージは無い。
   ```bash
   ln -s <このリポジトリ>/src/cli.ts ~/.local/bin/headless-demo-recorder   # PATH 上の任意のディレクトリ
   headless-demo-recorder doctor
   ```
   `bun link` も使えるが、登録先の `~/.bun/bin` が PATH に無いと呼べない。
2. エージェントに手順を渡す。`AGENTS.md` はこのリポジトリを開いたときにしか読まれないので、全文をグローバルな指示に貼らず、参照先だけを置く。
   - Claude Code: ユーザー単位のスキル（`~/.claude/skills/<name>/SKILL.md`）から、このリポジトリの `AGENTS.md` を読むよう指示する。
   - Codex: `~/.codex/AGENTS.md` に、デモ動画の依頼ではこのリポジトリの `AGENTS.md` を読むよう数行書く。
3. 使う側のプロジェクトでは、シナリオ内のパスがカレントディレクトリからの相対になる。出力先（例: `out/`）を `.gitignore` に入れる。入力の形式はエージェントが `headless-demo-recorder schema` で確かめる。

### 任意指定の防御

`check`、`capture`、`run` は次のフラグを受け付ける。指定しなければ制限はかからない。

- `--allow-origin <scheme://host:port>`（複数可）: シナリオ内の URL がすべて一致することを確認し、browser の通信先をこれらのホストに限る（agent-browser の `--allowed-domains`）。
- `--allow-app <bundleId>`（複数可）: desktop の入力先をこれらのアプリに限る。`src/appguard.ts` の拒否リスト（Chrome、Safari、Edge、Firefox 系、Terminal.app、Finder、システム設定。前方一致）に当たるアプリは、指定の有無にかかわらず拒否する。それ以外のブラウザやターミナル（Brave、Arc、iTerm2 など）は拒否リストに無い。

> 警告: `--allow-origin http://127.0.0.1:<port>` を許可すると、実行中はポートを区別できないため、ページの JS から**そのホスト上の他のローカルサービス（管理画面など）にも届きうる**。

モデル外の安全境界（録画回数の上限、許可リストの強制、録画前の人間による承認）は無い。破壊的な操作の検出は `check` の単語検査による推定で、安全保証ではない。

## 既知の制約

- OpenScreen のプロジェクト形式は、公開ドキュメントではなく v1.13 のアプリ内部のコードから読み取った。今後の版で変わる可能性があるため、書き出しの前に毎回 `openscreen info` で検証している。
- ブラウザ録画では、実時間を動画の長さに合わせて伸縮させ、操作の時刻を動画上へ対応付けている。ページの読み込みが止まると、ズームが ±200ms ほどずれることがある。
- デスクトップ録画は1つのウィンドウしか録らない。別ウィンドウで開くダイアログ内の操作は、座標を正しく対応付けられない。
- Whisper による字幕（`speechCaptions`）は、録画に音声が入っている場合しか使えない。ブラウザ録画には音声がない。
- 1プロセスで同時に録画できるのは composition の2本まで。別プロセスの `run` の同時実行や、同じシナリオを参照する2つの composition の同時実行は、ロックが無いため project dir を壊しうる。
- `openscreen record` は録画をアプリのフォルダ（macOS では `~/Library/Application Support/openscreen/recordings/`）に書く。desktop の capture は、録画が終わるとその動画・カーソル情報・session ファイルを project の `work/` に移す（`--keep-work` を付けなければ work ごと消える）。アプリの `media-links.registry.json` には参照が残るが、書き換えない。
- desktop の録画は同時に2本録れる（`openscreen record --window` はウィンドウ単位で、重なっていても個別に録れる）。ヘッドレスの `fill` / `press` はアクセシビリティ API で対象要素に直接届くため、もう一方のアプリの操作や前面化で文字が欠けることはなかった（2026-11 実測: TextEdit への入力と計算機のクリック・前面化を同時に各3回、欠落なし。`.omc/research/ac3-desktop-typing.md`）。
- agent-browser（0.41.1 で確認）は `--allowed-domains` の指定時に `window.WebSocket` を差し替えるが、`WebSocket.OPEN` などの定数を引き継がない。`readyState === WebSocket.OPEN` を確かめてから送信するページ（ttyd など）は、何も送信できなくなる。`--allow-origin` を指定したときは、`src/capture/ws-constants.js` を初期化スクリプトとして差し込んで定数を補う。
- 書き出しでは OpenScreen が余白と背景を付けるため、出力の解像度とフレームレートは入力と一致しない（例: 1280x720・30fps → 1784x1080・60fps）。
