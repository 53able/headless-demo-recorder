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
- `agent-browser`（0.32）、`agent-desktop`（1.0.2）
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

## pi で自律実行する

依頼文1つから完成動画までを、pi のエージェントに任せる。エージェントが使えるのは `capture_*` の8つのツールだけで、bash とファイル操作は無い。

入口は2つ。どちらも**実装中**（後続の wave で追加する）。

- `bin/make.ts`（実装中）: SDK を使う完全自動の実行。
- `bin/pi-capture`（実装中）: 対話用のランチャー。隔離したセッションで pi を起動する。

### 起動引数（許可リスト）

許可リストは**利用者の起動引数だけ**から受け取る。モデルが書くシナリオの値は無視する。既定は空で、`127.0.0.1` も許可しない。

- `--allow-origin <scheme://host:port>`: browser で触ってよい origin。
- `--allow-app <bundleId>`: desktop で操作してよいアプリ。

> 警告: `--allow-origin http://127.0.0.1:<port>` を許可すると、実行中はポートを区別できないため、ページの JS から**そのホスト上の他のローカルサービス（管理画面など）にも届きうる**。

### 保証の範囲

| 経路 | 自動実行 | 保証できること | 保証しないこと |
|---|---|---|---|
| file | 可 | 入力パスを利用者の指定に限る。外部への副作用がない | — |
| browser | 可 | 実行中: 許可外の**ホスト**に通信が出ない。ポート: シナリオ内の URL の静的な照合だけ | 許可範囲の中での送信や削除。許可したホストの別ポートへの、ページの JS による通信 |
| desktop | 不可（録画の前に利用者の承認が必須） | 入力の送り先を、許可したアプリに限る。システム系アプリ・ブラウザは拒否 | アプリが起こす外部への効果（リンクを開く、送信、共有） |

単語検査は防御を重ねるために残すが、安全保証ではない。

### 終了コード

| exit | 意味 |
|---|---|
| 0 | 完了（`accepted=true`） |
| 1 | 予期しない失敗 |
| 2 | 引数・入力の誤り |
| 3 | 人への引き継ぎ（desktop の承認待ち、環境の不足） |
| 4 | 予算切れ・品質未達 |

### 成果物

run ごとに `runs/<id>/` に保存する（ツール呼び出しの記録、予算の推移、下見の記録 `explore.json`、`summary.json`、完成動画、確認画像、`verdict.json`）。中断・失敗時の部分的な成果物は `runs/<id>/partial/` に移す。

### desktop の承認

desktop のシナリオは検証のあと `handoff`（exit 3）で止まる。利用者が別のターミナルで承認する。

```
bun src/cli.ts approve <runId> <versionHash>
```

`approve` は、許可した bundle ID、全ステップ、字幕、ハッシュを表示し、TTY で `yes` の入力を求める。TTY でなければ拒否する。承認はハッシュに結び付き、シナリオが1文字でも変われば無効になる。承認後は `bun bin/make.ts --resume <runId>` で録画以降を続ける。

## 既知の制約

- OpenScreen のプロジェクト形式は、公開ドキュメントではなく v1.13 のアプリ内部のコードから読み取った。今後の版で変わる可能性があるため、書き出しの前に毎回 `openscreen info` で検証している。
- ブラウザ録画では、実時間を動画の長さに合わせて伸縮させ、操作の時刻を動画上へ対応付けている。ページの読み込みが止まると、ズームが ±200ms ほどずれることがある。
- デスクトップ録画は1つのウィンドウしか録らない。別ウィンドウで開くダイアログ内の操作は、座標を正しく対応付けられない。
- Whisper による字幕（`speechCaptions`）は、録画に音声が入っている場合しか使えない。ブラウザ録画には音声がない。
- 録画は1件ずつしか実行できない。並列セッションには未対応。
