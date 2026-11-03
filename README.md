# headless-demo-recorder

エージェントが UI を操作している間の画面を録画する。そのあと、人の手を介さずに動画を編集・書き出しする。編集で加えるのは次の5つ。

- ズーム
- 操作位置のマーカー（任意で動くカーソル）
- 字幕
- 秘密情報のぼかし
- 待ち時間の早送り

```
scenario.json ─┬─ browser: agent-browser（操作 + WebM 録画 + 要素の矩形取得）
               ├─ desktop: agent-desktop（アクセシビリティ API で操作）+ openscreen record --window
               └─ file:    既存の任意の動画（+ 任意の events.json）
                     │
                     ▼  操作ログ: [{ tMs, kind, rect, point, caption, redact }]
               compile.ts ── zoomRegions / annotationRegions / speedRegions / マーカー（動画へ焼き込む）/ 合成 cursor.json（任意）
                     │
                     ▼
               openscreen export（ヘッドレス）──▶ MP4 / GIF
```

## 操作ログを使う理由

OpenScreen の `--auto-zoom` は、実際のマウスクリックを手がかりにズームを付ける。agent-browser と agent-desktop はポインタを動かさずに操作するので、ヘッドレス実行ではクリックが記録されない。

そこで各アクションの実行時に、対象要素の矩形と動画上の時刻を記録する。`compile.ts` はこの操作ログから次のものを生成する。

- **ズーム**: 操作した要素を中心にズームする。近接したアクションは1つのズームにまとめ、ズーム同士が重ならないようにする。
- **マーカー**: 操作した要素に黄色のリングを動画へ焼き込む（既定で有効）。リングはズームと一緒に動く。
- **合成カーソル**: 既定では無効。有効にすると、各要素へ移動してクリックするカーソルを描く。

  マーカーと合成カーソルの細かい規則（付く操作、止め方、composition での扱い）は、スキルの `SKILL.md` の「マーカーとカーソル」にある。
- **字幕**: `step.caption` の内容を、画面に固定したテキストとして表示する。ズームしても位置と大きさは変わらない。
- **ぼかし**: `redact: true` を付けた要素に適用する。
- **早送り**: `edit.idleSpeedupMs` を指定すると、操作のない区間を `edit.idleSpeed`（既定 4）倍速にする。各操作の後 1.2 秒と次の操作の前 0.6 秒は通常の速さで残し、その間が `idleSpeedupMs` 以上あるときだけ早送りする。

## 必要環境

- macOS
- Node.js 22.20 以上（スキルの導入に使う `npx skills` のため）
- bun、ffmpeg
- `agent-browser`（0.41）、`agent-desktop`（1.0.2）
- OpenScreen（2.2.0 で確認済み。`openscreen` CLI に PATH が通っていること）
  - macOS で PATH に通すときは、シンボリックリンクではなく実体を `exec` するスクリプトを置く（例: `printf '#!/bin/sh\nunset ELECTRON_RUN_AS_NODE\nexec /Applications/Openscreen.app/Contents/MacOS/Openscreen "$@"\n'`）。シンボリックリンク経由だと `help` と `export` は動くが、`record` が `Renderer crashed` で失敗する（実測）。
- デスクトップ録画には、ターミナルへの画面収録とアクセシビリティの権限付与が必要

スキルの導入でまとめて入るのは、スキル本体（`SKILL.md` と `references/`）、CLI（`scripts/`）、例（`assets/`）だけ。上の外部ツールと権限は別に用意する。

## インストール

[skills](https://github.com/vercel-labs/skills) CLI でスキルとして導入する。どのプロジェクトからでも使うなら `-g` を付ける。

```bash
npx skills add 53able/headless-demo-recorder -g -a claude-code -a codex
```

| 範囲 | 指定 | Claude Code が読む場所 | Codex が読む場所 |
|---|---|---|---|
| ユーザー全体 | `-g` | `~/.claude/skills/headless-demo-recorder` | `~/.agents/skills/headless-demo-recorder` |
| このプロジェクトだけ | なし | `.claude/skills/headless-demo-recorder` | `.agents/skills/headless-demo-recorder` |

- 既定では1か所に実体を置き、各エージェントの場所からシンボリックリンクを張る。リンクを使えない環境では `--copy` を付ける。
- プロジェクトに入れると、`.agents/skills/`、`.claude/skills/` と `skills-lock.json` がプロジェクトに作られる。これらをコミットすれば、チームで同じ版を使える。
- 更新は `npx skills check`（更新の有無）と `npx skills update headless-demo-recorder`、削除は `npx skills remove headless-demo-recorder`（いずれも `-g` で導入したなら `-g` を付ける）。
- 上の導入は `main` の最新を追う。更新の有無はスキルフォルダの中身で判定され、バージョン番号は見ない。
- 版を固定するなら、タグを URL で指定する。固定した導入は `skills update` でもそのタグに留まり、別の版へは同じコマンドでタグを替えて入れ直す。版の一覧は [タグ](https://github.com/53able/headless-demo-recorder/tags)（v0.2.0 以降）。

  ```bash
  npx skills add https://github.com/53able/headless-demo-recorder/tree/v0.3.1/skills/headless-demo-recorder -g -a claude-code -a codex
  ```
- CLI は実行時の依存パッケージを持たず、導入先の `scripts/cli.ts` を bun でそのまま実行する。`bun install` は要らない。

導入できたかは、導入先の CLI で確かめる。

```bash
bun ~/.claude/skills/headless-demo-recorder/scripts/cli.ts doctor   # ツールと権限（読み取りのみ）
bun ~/.claude/skills/headless-demo-recorder/scripts/cli.ts schema   # 入力の型定義、手順書、例の場所
```

### AI に頼む

Claude Code か Codex に次のプロンプトを貼ると、導入から確認まで進める。ツールの導入と既存ファイルの上書きの前には確認を求め、OS の権限は変えずに案内だけする。

````text
headless-demo-recorder を、このマシンのどのプロジェクトからでも Claude Code と Codex で使えるように導入してください。

## 完了条件
- `npx skills ls -g` に headless-demo-recorder が出る
- 任意のディレクトリで `bun ~/.claude/skills/headless-demo-recorder/scripts/cli.ts doctor` が `"ok": true` を返す
- 同じく `schema` が `"ok": true` を返す

## 手順
1. 前提を調べる（読み取りのみ）: macOS であること、Node.js（22.20 以上）・`bun`・`ffmpeg`・`agent-browser`（0.41 以上）・`agent-desktop`（1.0.2 以上）の有無と版、`/Applications/Openscreen.app` の有無と版（2.2.0 で確認済み）。足りないものを一覧にする。
2. `npx skills add 53able/headless-demo-recorder -g -a claude-code -a codex -y` を実行する。
3. PATH 上のユーザー用ディレクトリ（`~/.local/bin` が PATH にあればそこ。無ければ PATH にある書き込み可能なユーザー用ディレクトリ）に、`openscreen` というシェルスクリプトを置いて実行権限を付ける。中身は `unset ELECTRON_RUN_AS_NODE` のあと `exec /Applications/Openscreen.app/Contents/MacOS/Openscreen "$@"`。シンボリックリンクにはしない（`record` が失敗する）。
4. `bun ~/.claude/skills/headless-demo-recorder/scripts/cli.ts doctor` と同じく `schema` を実行し、結果を報告する。

## 守ること
- 足りないツールの導入（brew install、npm i -g、OpenScreen の入手）は、実行するコマンドを一覧にして、私の承認を得てから行う。
- 置き先にファイルやリンクが既にあるときは、中身を確認して私に聞いてから上書きする。
- macOS の画面収録・アクセシビリティの権限を変更しない。`doctor` の permission が granted でなければ、どのアプリ（このエージェントを動かしているターミナル）に付与すればよいかを伝えて止める。
- `sudo` を使わない。`~/.claude/CLAUDE.md`、`~/.codex/AGENTS.md`、シェルの設定ファイル（`.zshrc` など）を編集しない。
- Codex で実行しているなら、`npx skills add` と `doctor` はサンドボックス外で実行する許可を最初から求める（ネットワークに接続し、openscreen はサンドボックス内でクラッシュする）。
- 各手順のあとに「✅ <やったこと>」を1行出す。完了条件を満たしたら、または私の判断が要るところで止まる。
````

導入後は、どのプロジェクトでも「このページのサインアップを15秒のデモ動画にして」のように頼めばスキルが使われる。

## 使い方

ふだんはエージェントに頼めばよい。手でコマンドを打つときは、作業中のプロジェクトで実行する。シナリオ内のパスはカレントディレクトリからの相対になる。以下では、導入先の CLI を呼ぶ関数 `headless-demo-recorder` を定義して使う。

```bash
headless-demo-recorder() { bun ~/.claude/skills/headless-demo-recorder/scripts/cli.ts "$@"; }

headless-demo-recorder doctor                                    # ツールと権限を確認（読み取りのみ）
headless-demo-recorder schema                                    # 入力の型定義、手順書、例の場所
headless-demo-recorder check demo/signup.json                    # 検証のみ。何も起動しない
headless-demo-recorder run demo/signup.json --allow-origin https://example.com   # check → capture → render → inspect
headless-demo-recorder render out/signup.project --edit edit.json --out out/v2.mp4   # 再録画せずに再編集
headless-demo-recorder inspect out/signup.project --video out/v2.mp4   # 書き出しの各コマを1枚の画像に並べる
```

録画には画面がそのまま入る。出力先（例: `out/`）を作業中のプロジェクトの `.gitignore` に入れる。

`run` は `out/<name>.project/` に次のファイルを作る。書き出しに失敗したときや見た目を変えたいときは、同じプロジェクトに対して `render` をやり直せばよい。

| ファイル | 作るコマンド | 中身 |
|---|---|---|
| `capture.mp4`、`capture.json`、`events.json` | `capture` | 録画、録画の情報、操作ログ |
| `capture.marked.mp4` | `render` | マーカーを焼き込んだ録画（`capture.mp4` は変えない） |
| `<name>.openscreen`、`render.json` | `render` | OpenScreen のプロジェクトと、書き出しの記録 |
| `inspect-sheet.png` | `inspect` | アクションごとに1コマ並べた確認用の画像 |

各コマンドは stdout に JSON を1つだけ出力する。失敗時の JSON には `stage`、`code`、`retry`（`safe` / `after-fix` / `no`）、`hint` が入る。

コマンドの一覧と、エージェントの作業手順・ガードレールの正本はスキルの `SKILL.md`（このリポジトリでは [`skills/headless-demo-recorder/SKILL.md`](skills/headless-demo-recorder/SKILL.md)）。依頼によって読む手順書は `references/` にある。

- [`references/session.md`](skills/headless-demo-recorder/references/session.md): 画面を見ながら1手ずつ録る、複数のエージェントで同時に録る
- [`references/file-source.md`](skills/headless-demo-recorder/references/file-source.md): 録画済みの動画に編集を足す
- [`references/composition.md`](skills/headless-demo-recorder/references/composition.md): 2本の録画を同時に録って1本に結合する
- [`references/codex-sandbox.md`](skills/headless-demo-recorder/references/codex-sandbox.md): Codex のサンドボックスで外に出すコマンド

入力 JSON の形式と制約は `scripts/types.ts`、例は `assets/` にあり、`schema` がこれらの場所をまとめて返す。

## クックガイド

よくある用途ごとに、AI への頼み方と、AI が書くシナリオの要点を示す。どのレシピも `check` → `run` → inspect-sheet の目視、の順で進む。

### ウェブページの操作を録る
> 「https://example.com のサインアップ手順を、入力欄を順に埋める20秒のデモ動画にして」

```json
{
  "name": "signup",
  "source": { "type": "browser", "url": "https://example.com/signup", "viewport": [1280, 800] },
  "steps": [
    { "action": "fill", "target": "#email", "value": "demo@example.com", "caption": "メールアドレスだけで始められる" },
    { "action": "click", "target": "text=続ける", "caption": "確認メールの前に、まず使い心地を見られる" }
  ],
  "output": { "path": "out/signup.mp4" }
}
```
- 対象は CSS・id・テキストのセレクタで指す（`@e3` のような下見の参照は使えない）。字幕には「何をしたか」より「なぜそうするか」を書く。
- `run demo/signup.json --allow-origin https://example.com` で、通信先をそのホストに限れる。

### macOS アプリの操作を録る
> 「計算機で 7+8 を計算する様子を GIF にして」

```json
{
  "name": "calculator",
  "source": { "type": "desktop", "app": "Calculator", "launch": true },
  "steps": [
    { "action": "click", "target": { "role": "button", "name": "7", "exact": true }, "caption": "7+8 を計算" },
    { "action": "click", "target": { "role": "button", "name": "加算", "exact": true } },
    { "action": "click", "target": { "role": "button", "name": "8", "exact": true } },
    { "action": "click", "target": { "role": "button", "name": "計算実行", "exact": true }, "caption": "答えは 15" }
  ],
  "output": { "path": "out/calculator.gif", "gifFps": 20, "gifSize": "medium" }
}
```
- 対象はアクセシビリティの `role` と `name`（表示言語の名前。日本語環境なら「加算」）で指す。`--allow-app com.apple.calculator` で入力先をそのアプリに限れる。
- `launch: true` なら `app` は起動に使う名前（`Calculator`）でよい。`launch` を付けないときは、表示言語での名前（日本語環境なら「計算機」）を書く。
- 実際のウィンドウを録るので、通知も映り込む。録画前にアプリを初期状態に戻しておく。

### 録画済みの動画に字幕とズームを付ける
> 「この QuickTime の録画 `rec.mov` に、操作の説明字幕とクリック位置へのズームを付けて」

```json
{ "name": "rec", "source": { "type": "file", "path": "rec.mov", "events": "rec.events.json" }, "output": { "path": "out/rec.mp4" } }
```
```json
[
  { "tMs": 1200, "kind": "click", "point": { "cx": 0.42, "cy": 0.18 }, "caption": "設定を開く" },
  { "tMs": 4800, "kind": "click", "point": { "cx": 0.70, "cy": 0.55 }, "caption": "通知をオフにする" }
]
```
- 操作ログの座標は動画フレームに対する 0〜1 の比率（ピクセル値ではない）。ブラウザもアプリも起動しない。詳しくは [`references/file-source.md`](skills/headless-demo-recorder/references/file-source.md)。

### パスワードや個人情報をぼかす
> 「ログインのデモで、パスワード欄と右上のアカウント名をぼかして」

- 入力欄はステップに `"redact": true` を付ける。その時刻から最後までぼかしが掛かる。
- 決まった場所は `edit.redact` に `{ "rect": { "x": 0.75, "y": 0, "w": 0.25, "h": 0.06 }, "startMs": 0, "endMs": 8000 }` のように書く。
- 書き出したら inspect-sheet で、ぼかしが欄を覆っているかを必ず目で確かめる。

### 待ち時間を早送りする
> 「読み込み待ちが長いので、操作のない時間は早送りして」

- `edit` に `"idleSpeedupMs": 1500, "idleSpeed": 4` を書くと、操作の後 1.2 秒と次の操作の前 0.6 秒を除いた操作のない区間が 1.5 秒以上あれば、その区間が4倍速になる。

### 2つの操作を同時に録って1本にする
> 「管理画面と利用者画面を左右に並べて、同じ時間に映る動画にして」

既存のシナリオを2本参照する構成ファイル（composition）を書く。参照先のシナリオは変えない。

```json
{
  "name": "calc-wiki",
  "scenarios": ["demo/calculator.json", "demo/wikipedia.json"],
  "scenes": [
    { "layout": "side-by-side", "streams": [{ "scenario": "calculator" }, { "scenario": "wikipedia-search" }] },
    { "layout": "single", "streams": [{ "scenario": "wikipedia-search" }] }
  ],
  "edit": { "titles": [{ "text": "2つの録画を1本に", "startMs": 0, "endMs": 1500 }] },
  "output": { "path": "out/calc-wiki.mp4", "quality": "good" }
}
```
- `run demo/calc-wiki.json --allow-app com.apple.calculator --allow-origin https://en.wikipedia.org` で2本を同時に録り、1本に結合する。
- 開始時刻だけが揃い、シナリオ間の操作の待ち合わせ（A が送ったら B が受け取る）はできない。結合のされ方と直し方は [`references/composition.md`](skills/headless-demo-recorder/references/composition.md)。

### 画面を見ながら1手ずつ録る
> 「このページで在庫のある商品を探して、カートに入れるところまでデモにして」（どの商品が出るかは開くまで分からない）

```bash
headless-demo-recorder session start demo/s.json --allow-origin https://example.com   # 録画を開いたままにする
headless-demo-recorder session observe out/s.project --screenshot    # 画面を見る（act で使える参照付き）
headless-demo-recorder session act out/s.project '{"action":"click","target":"@e3","caption":"理由"}'   # 1手だけ進める
headless-demo-recorder session stop out/s.project                    # 止めて保存（あとは render / inspect）
```
- 失敗した手（要素が見つからないなど）では録画は止まらず、その手はログから外れる。もう一度観察して、別の手を選べばよい。
- 考えている時間も録画に入るので、`edit.idleSpeedupMs` で早送りする。手順の詳細は [`references/session.md`](skills/headless-demo-recorder/references/session.md)。

### 複数のエージェントに別々のアプリを操作させて録る
> 「2つのエージェントに、それぞれ計算機とブラウザを同時に操作させて、左右に並べた動画にして」

- エージェントごとにシナリオを用意し、同じ `--group` で `session start` する。各エージェントは自分の project だけを操作し、最後に composition で結合する。開始時刻は自動で揃う。手順は [`references/session.md`](skills/headless-demo-recorder/references/session.md) の「複数のエージェントで同時に録る」。
- 実際のマウスポインタは動かないので、利用者は録画中も自分の作業を続けられる。

### 録り直さずに直す
> 「2つ目の字幕を変えて、ズームを弱くして」

- 字幕・時刻・座標は `out/<name>.project/events.json`、ズームや見た目はシナリオの `edit` を直し、`render out/<name>.project --scenario <file> --force` を実行する。アプリやページは再度操作されない。

## Codex / Claude Code から使う

エージェントはスキルを読み込み、シェルから `bun <skill-dir>/scripts/cli.ts <command>` を呼んで、stdout の JSON を読んで次の手を決める。`<skill-dir>` はスキルの導入先（例: `~/.claude/skills/headless-demo-recorder`）。

使う前に、次を利用者が済ませておく。

- 画面収録とアクセシビリティの権限を、エージェントを動かしているターミナルアプリ（Terminal、iTerm2、エディタ内蔵ターミナルなど）に付与する。`doctor` で確認できる。
- Codex では、録画と書き出しのコマンドをサンドボックス外で実行する許可が要る。対象のコマンドと理由は [`references/codex-sandbox.md`](skills/headless-demo-recorder/references/codex-sandbox.md)。
- `inspectSheet` の目視確認には、画像を読めるモデルが要る。

### 任意指定の防御

`check`、`capture`、`run`、`session start` は次のフラグを受け付ける。指定しなければ制限はかからない。

- `--allow-origin <scheme://host:port>`（複数可）: シナリオ内の URL がすべて一致することを確認し、browser の通信先をこれらのホストに限る（agent-browser の `--allowed-domains`）。
- `--allow-app <bundleId>`（複数可）: desktop の入力先をこれらのアプリに限る。スキルの `scripts/appguard.ts` の拒否リスト（Chrome、Safari、Edge、Firefox 系、Terminal.app、Finder、システム設定。前方一致）に当たるアプリは、指定の有無にかかわらず拒否する。それ以外のブラウザやターミナル（Brave、Arc、iTerm2 など）は拒否リストに無い。

> 警告: `--allow-origin http://127.0.0.1:<port>` を許可すると、実行中はポートを区別できないため、ページの JS から**そのホスト上の他のローカルサービス（管理画面など）にも届きうる**。

モデル外の安全境界（録画回数の上限、許可リストの強制、録画前の人間による承認）は無い。破壊的な操作の検出は `check` の単語検査による推定で、安全保証ではない。

## 既知の制約

- OpenScreen のプロジェクト形式は、公開ドキュメントではなくアプリ内部のコードから読み取った（2.2.0 で確認）。今後の版で変わる可能性があるため、書き出しの前に毎回 `openscreen info` で検証している。
- ブラウザ録画では、実時間を動画の長さに合わせて伸縮させ、操作の時刻を動画上へ対応付けている。ページの読み込みが止まると、ズームが ±200ms ほどずれることがある。
- デスクトップ録画は1つのウィンドウしか録らない。別ウィンドウで開くダイアログ内の操作は、座標を正しく対応付けられない。1本の録画の中でアプリを切り替えることもできないので、複数のアプリはそれぞれ録画して composition で並べる。
- ブラウザ録画は1つのタブだけを録る。新しいタブを開く操作は失敗として返る。扱いと回避の方法は `SKILL.md` の「操作の種類」。
- ドラッグ、ホバー、座標指定のクリックには対応しない（理由は `SKILL.md` の「操作の種類」）。
- `session` の録画は、利用者のマシン上で常駐プロセスとして動き続ける。`session stop` を忘れても、一定時間要求が無ければ停止・保存される（[`references/session.md`](skills/headless-demo-recorder/references/session.md)）。
- Whisper による字幕（`speechCaptions`）は、録画に音声が入っている場合しか使えない。ブラウザ録画には音声がない。
- 1プロセスで同時に録画できるのは composition の2本まで。別プロセスの `run` の同時実行や、同じシナリオを参照する2つの composition の同時実行は、ロックが無いため project dir を壊しうる。
- `openscreen record` は録画をアプリのフォルダ（macOS では `~/Library/Application Support/openscreen/recordings/`）に書く。desktop の capture は、録画が終わるとその動画・カーソル情報・session ファイルを project の `work/` に移す（`--keep-work` を付けなければ work ごと消える）。アプリの `media-links.registry.json` には参照が残るが、書き換えない。
- desktop の録画は同時に2本録れる（`openscreen record --window` はウィンドウ単位で、重なっていても個別に録れる）。ヘッドレスの `fill` / `press` はアクセシビリティ API で対象要素に直接届くため、もう一方のアプリの操作や前面化で文字が欠けることはなかった（2026-11 実測: TextEdit への入力と計算機のクリック・前面化を同時に各3回、欠落なし）。
- agent-browser（0.41.1 で確認）は `--allowed-domains` の指定時に `window.WebSocket` を差し替えるが、`WebSocket.OPEN` などの定数を引き継がない。`readyState === WebSocket.OPEN` を確かめてから送信するページ（ttyd など）は、何も送信できなくなる。`--allow-origin` を指定したときは、スキルの `scripts/capture/ws-constants.js` を初期化スクリプトとして差し込んで定数を補う。
- 書き出しでは OpenScreen が余白と背景を付けるため、出力の解像度とフレームレートは入力と一致しない（[`references/file-source.md`](skills/headless-demo-recorder/references/file-source.md)）。

## 開発

```bash
git clone https://github.com/53able/headless-demo-recorder && cd headless-demo-recorder
bun install && bun test && bun run typecheck
```

配布の単位、検査、配布の形での確認、実録画での確認、リリースの手順は [`AGENTS.md`](AGENTS.md) にある。

### 説明動画を作り直す

`demo/howto/` は、このツールの使い方を見せる説明動画（`out/howto.mp4`）を、このツール自身で録画する手順である。ブラウザ上の端末で実際にコマンドを打ち、その画面を browser ソースで録画する。端末では次の順に実行する。

1. 一時ディレクトリのプロジェクトに `npx skills add` でスキルを導入し、導入先の CLI で `doctor` を実行する。導入元は GitHub ではなく手元のリポジトリなので、作業ツリーの内容がそのまま映る。
2. リポジトリに戻り、`check` と、browser・desktop・file・composition の `run` を実行する。
3. `session` で Wikipedia を開き、`observe` で見つけた検索欄の参照に `act` で入力して検索し、`stop` と `render` で書き出す。
4. 結果のページで、inspect-sheet と書き出した動画を順に映す。

端末は [wterm](https://github.com/vercel-labs/wterm)（DOM で描画するウェブ端末）と、Bun の PTY（`Bun.spawn` の `terminal`）で動かす。`demo/howto/server.ts` が、端末、結果ページ（`/demo/`）、`out/` の配信を 127.0.0.1:7681 の1つのポートで受け持つ。

```bash
bun install --cwd demo/howto      # 初回のみ（@wterm/dom）。型検査は bun run --cwd demo/howto typecheck
bun demo/howto/server.ts &        # 127.0.0.1:7681
bun skills/headless-demo-recorder/scripts/cli.ts run demo/howto/scenario.json --allow-origin http://127.0.0.1:7681 --force
kill %1
```

- 端末内の desktop 録画で計算機が起動するので、desktop 録画の権限が要る（`doctor` で確認する）。計算機は表示が空の状態にしておく（最初の手の「すべて消去」ボタンは、表示があると名前が変わる）。
- Wikipedia を開くので、ネットワーク接続が要る。session の手は `demo/howto/session-wikipedia.json` を元にする。
- 端末の WebSocket は、`Origin` が `http://127.0.0.1:7681` の接続だけを受け付ける。書き込みできるシェルなので、普段のブラウザで開いている他のページからは操作できないようにしている。
- 録画される端末は、利用者の設定ではなく `demo/howto/zdotdir/.zshrc` で起動する。プロンプトにユーザー名やホームのパスは出ず、履歴も保存しない。README と同じ関数 `headless-demo-recorder <cmd>`（`bun skills/headless-demo-recorder/scripts/cli.ts <cmd>`）を定義し、`npx skills` の利用状況の送信を止める。
- 端末内のコマンドは、出力のパスを `out/` からの相対パスに直して表示する。絶対パスにはホームディレクトリが含まれるためである。`run` と `session` のコマンドは、進行ログの stderr を捨てる。
- 標準の Terminal.app を agent-desktop で操作する方法は取らない。`skills/headless-demo-recorder/scripts/appguard.ts` の拒否リストが Terminal.app への入力を拒否するためである。
