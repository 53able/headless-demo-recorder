---
status: approved
---

# TASKS: 2026-11-03-docs-refresh

## 方針

- 先に CLI（`schema` とヘルプ）を直し、文書はそれに合わせて書く。文書が `schema` の新しい欄やヘルプを参照するため、逆の順だと文書が一時的に誤る。
- 事実の置き場所は次のように決め、ほかの文書はそこへリンクする。
  - 入力の形式と制約: `scripts/types.ts`
  - エージェントの手順と規則: SKILL.md と `references/`
  - 開発と配布の手順: AGENTS.md
  - README: 人の入口。概要、導入、使い方の入口、レシピ、既知の制約の要約だけを置く
- README から消す内容は、消す前に SKILL.md / `references/` / AGENTS.md に同じ事実があることを確かめる。無ければ移してから消す。情報を失わないため。
- `schema` には `references`（`references/` の `.md` の実体のパスを名前順に並べた配列）を足す。既存の欄は変えない。`examples` と同じく `readdir` で集め、ファイル名を書き込まない。ファイルを足しても CLI を直さずに済むため。
- OpenScreen の版は、文書と `doctor` の修正案のどちらも「2.2.0 で確認済み」と書く。最低版は確かめていないので、最低版として断定しない。
- README の版を固定した導入の例は `v0.3.1` にする。この PR で版を上げ、マージ後に AGENTS.md の手順でタグを打つため。
- 捨てた案: README を SKILL.md から自動生成する。生成の仕組みが新たに要り、人向けとエージェント向けで書き方が違うため採らない。

## 停止条件

- `schema` の既存の欄を読む箇所が、リポジトリ内（`demo/`、テスト、文書）で欄の追加によって壊れると分かった場合。
- README から消そうとする事実の移し先が、SKILL.md / references / AGENTS.md のどこにも決まらない場合。
- コードを読んで、spec の受入条件と矛盾する事実が見つかった場合（spec を draft に戻す）。

## タスク

- [x] T1: `schema` が `references/` のパスを返す
  - Done when: `bun test` の `schema` のテストで、返った `references` がすべて存在し、`references/` の `.md` の集合と一致する。既存の欄（`ok`、`guide`、`examples`、`note`、`types`）の確認も通る。
  - 依存: なし
  - AC: AC9

- [x] T2: CLI のヘルプと `doctor` の修正案を、現在の振る舞いに合わせる
  - 直す内容:
    - ヘルプの Guards の行に `session start` を含める。
    - `run` にリスク区分 R2 を付ける。
    - `schema` の説明に references を含める。
    - `plan` / `render` に `--scenario` / `--composition` を書く。
    - `doctor` の OpenScreen の修正案を「2.2.0 で確認済み」にする。
  - Done when: `bun scripts/cli.ts`（引数なし）の出力に上の各点が出る。`bun test` と `bun run typecheck` が通る。
  - 依存: T1
  - AC: AC10

- [x] T3: エージェント向けの文書（SKILL.md、`references/`、`types.ts` のコメント）を現在の振る舞いに合わせる
  - 直す内容:
    - desktop で `launch: false` のとき `app` に書く名前（`DesktopSource` の型コメント）
    - コマンド表の `session start` の `--allow-*`、`plan` / `render` のフラグ、`session status` の状態、`--session-name` / `--keep-work`
    - マーカーを付けない対象（redact のすべてのイベント）
    - `inspect` の `timelineEdited` / `note` と `render.json`
    - `schema` の `references`
    - composition で使えない `idleSpeed`（`references/composition.md`）
  - Done when: 調査で挙げたエージェント向けの各項目について、文書の行と根拠としたコードの行を突き合わせた表が埋まり、すべて一致する。SKILL.md が 500 行以内で、手順0の行が変更前と同じ。
  - 依存: T2
  - AC: AC1、AC2、AC7

- [x] T4: README を人の入口として書き直す
  - 直す内容:
    - 構成を概要、導入、使い方の入口、レシピ、既知の制約の要約にする。
    - エージェント向けの規則（Codex のサンドボックス、新しいタブ、composition の手順、session の手順、file ソースの手順、マーカーの細則）は消し、SKILL.md / `references/` へリンクする。
    - README に固有の古い記述を直す: `.omc/research/` の参照、早送りが始まる条件、OpenScreen の版、`v0.3.0` の固定、略記の不一致、説明動画の stderr、`render` が作るファイル。
    - `docs/tool-design-review.md` へのリンクを消す。
  - Done when: README に、調査で重複とした規則の説明が残っていない（`grep`）。README から SKILL.md と `references/` の各ファイルへのリンクがあり、開ける。README に `.omc/research` と `tool-design-review` の文字列がない。
  - 依存: T3
  - AC: AC1、AC2、AC3、AC4

- [x] T5: `docs/tool-design-review.md` を削除し、AGENTS.md を整理する
  - 直す内容: ファイルを削除する。AGENTS.md の「現行仕様の参照先」からその記述を消す。AGENTS.md と README で重複していた配布の単位と導入の確認は、AGENTS.md に残して README からリンクする。
  - Done when: ファイルが無く、`grep -rn tool-design-review`（`docs/changes/` を除く）が何も返さない。
  - 依存: T4
  - AC: AC3、AC8

- [x] T6: 受入条件を通しで確かめる
  - 確かめる内容:
    - 変更した文書に編集メモがない（`grep`）。
    - README と SKILL.md に書いた R0 のコマンド（`doctor`、`schema`、`check`、`plan`、`inspect`）を実行する。
    - `bun test` と `bun run typecheck`。
    - AGENTS.md の「配布の形での確認」で、導入先の `schema` が導入先の `references/` を返す。
  - Done when: 上のすべてが期待どおりで、AC2 の突き合わせ表を PR 本文に載せられる状態になっている。
  - 依存: T5
  - AC: AC2、AC5、AC6、AC9

## 承認

> 承認する (Recommended)

2026-11-03、方式・タスクの順序（T1→T6 の直列）・任せる範囲（既定のまま。コミット、push、PR の更新は指示があってから）の3点に対する回答。

## メモ
- T2: `session status` の状態は `SessionStatus`（starting / recording / stopping / stopped / failed）に加え、録画プロセスが落ちたときの `recorder exited` と、サーバが無いときの `… (server not running)` がある。ヘルプには利用者が目にする値を書いた。
- T3: エージェント向けの項目の突き合わせ（文書の行 ↔ 根拠のコード）。
  - launch:false の app 名: types.ts:43 ↔ capture/desktop.ts:68
  - session start の --allow-*: SKILL.md:36 ↔ cli.ts:252
  - マーカーを付けない redact: SKILL.md:89 ↔ compile.ts:139
  - inspect の timelineEdited / note: SKILL.md:67 ↔ inspect.ts:42
  - plan / render のフラグ: SKILL.md:31 ↔ cli.ts:344
  - --keep-work / --session-name: SKILL.md:42 ↔ cli.ts:70, cli.ts:366
  - session status の状態: SKILL.md:39 ↔ session.ts:317, cli.ts:283
  - schema の references: SKILL.md:16 ↔ cli.ts:456
  - composition で使われない idleSpeed: references/composition.md:12 ↔ cli.ts:150
- T4: README から消す composition の細則（場面の再生、出力の大きさ、ズームの衝突、結果 JSON、120 秒の待ち合わせ）は `references/composition.md` に無かったため、先に移した。説明動画の stderr は、実際には `run` と `session` のコマンドだけが捨てていたので、その事実に合わせた。
- T6: 重複の語を全文書で数えた。`Operation not permitted`（SKILL.md の失敗時の対応）と `idle-timeout`（SKILL.md のコマンド表の書式）は、SKILL.md 側では症状と書式だけを示して `references/` を指しており、説明は references の1か所にある。
- T6: シェルの変数に入れたコマンドが zsh で単語に分かれず、R0 の確認が1回失敗した。関数で書き直して実行した（コードの問題ではない）。
