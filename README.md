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
- デスクトップ録画には、ターミナルへの画面収録とアクセシビリティの権限付与が必要

## 使い方

```bash
bun install && bun test
bun src/cli.ts doctor                                   # ツールと権限を確認（読み取りのみ）
bun src/cli.ts check scenarios/browser-wikipedia.json   # 検証のみ。何も起動しない
bun src/cli.ts run scenarios/browser-wikipedia.json     # capture → render → inspect
bun src/cli.ts render out/wikipedia-search.project --edit edit.json --out out/v2.mp4   # 再録画せずに再編集
```

`capture` は書き出しより先に、`out/<name>.project/` へ次の3つを保存する。

- `capture.mp4`
- `capture.json`
- `events.json`

書き出しに失敗したときや見た目を変えたいときは、同じプロジェクトに対して `render` を実行し直せばよい。`run` は目視確認用に、アクションごとに1コマ並べた `inspect-sheet.png` も出力する。

各コマンドは JSON を1つだけ出力する。失敗時の JSON には `stage`、`code`、`retry`（`safe` / `after-fix` / `no`）、`hint` が入る。

- エージェントの作業手順とガードレール: `AGENTS.md`
- 設計の根拠: `docs/tool-design-review.md`

## Codex / Claude Code から使う

エージェントはシェルから `bun src/cli.ts <command>` を呼び、stdout の JSON を読んで次の手を決める。作業手順とガードレールの正本は `AGENTS.md` で、Codex はこれをそのまま読む。Claude Code は `CLAUDE.md`（中身は `@AGENTS.md` の1行）を経由して同じ内容を読む。

使う前に、次を利用者が済ませておく。

- 画面収録とアクセシビリティの権限を、エージェントを動かしているターミナルアプリ（Terminal、iTerm2、エディタ内蔵ターミナルなど）に付与する。`doctor` で確認できる。
- Codex のサンドボックスでは、`doctor`、`render`、`run`、`capture`、および下見の `agent-browser` / `agent-desktop` にサンドボックス外での実行の許可が要る。`openscreen` CLI の実体は Electron アプリで、サンドボックス内で起動するとクラッシュし、macOS のクラッシュダイアログが出る（実測）。`check`、`plan`、`inspect` はサンドボックス内で動く（実測）。
- `inspectSheet` の目視確認には、画像を読めるモデルが要る。

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
- 録画は1件ずつしか実行できない。並列セッションには未対応。
- 書き出しでは OpenScreen が余白と背景を付けるため、出力の解像度とフレームレートは入力と一致しない（例: 1280x720・30fps → 1784x1080・60fps）。
