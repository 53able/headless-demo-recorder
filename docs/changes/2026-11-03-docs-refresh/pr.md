## 目的

文書を現在のコードに合わせ、同じ事実を1か所にだけ書く。README は人の利用者の入口にし、エージェント向けの規則は SKILL.md と `references/` に置く。あわせて、`schema` が `references/` の手順書を返すようにし、ヘルプと `doctor` の文字列を文書と同じ事実にそろえる。仕様は [`docs/changes/2026-11-03-docs-refresh/spec.md`](spec.md)、計画は [`tasks.md`](tasks.md)。

## 受入条件

| AC | 結果 | 証拠（テスト名・コマンド・出力） | 照合元（利用者の操作・業務知識・既存の契約） |
|---|---|---|---|
| AC1 誤り3件 | pass | `grep '\.omc/research' README.md` は該当なし。`launch: false` のときの `app` の名前は `types.ts` の `DesktopSource.app` の型コメントと README の計算機のレシピに書いた。`--allow-*` が `session start` に効くことは README の「任意指定の防御」と SKILL.md のコマンド表に書いた | `capture/desktop.ts:67-74`（`launch` のときだけローカライズ名に置き換わる）。`cli.ts:252`（`session start` が `allowOrigins` / `allowApps` を渡す） |
| AC2 古い記述12件 | pass | エージェント向けの9項目は、文書の行とコードの行の対応表を `tasks.md` のメモ（T3）に残した。README の項目（早送りの条件、OpenScreen の版、版の固定、略記、`render` が作るファイル、説明動画の stderr）も直した。独立レビューで、各主張をコードと突き合わせて一致を確認した | `compile.ts:193-195`（操作の後 1.2 秒・前 0.6 秒を残し、`b - a >= idleSpeedupMs` で早送り）。`compile.ts:139`（redact のイベントはマーカーなし）。`session.ts:317`、`cli.ts:283`（status の値）。`render.ts:9,43`（2.2.0 で確認）。`demo/howto/scenario.json`（stderr を捨てるのは `run` と `session` の手） |
| AC3 重複の解消 | pass | 重複していた語（`NEW_TAB`、`--headed`、`Operation not permitted`、`idle-timeout`、`1784x1080`、`PROJECT_COLLISION`、`startSkewMs`）を README、AGENTS.md、SKILL.md、`references/` で数えた。説明はそれぞれ1か所にある。`Operation not permitted` と `idle-timeout` は SKILL.md にも出るが、症状とコマンドの書式だけを示して `references/` を指している | 既存の役割の分担（AGENTS.md の方針: 形式は types.ts、毎回は要らない手順は references） |
| AC4 README から正本へ | pass | README の相対リンク6件（SKILL.md、`references/` の4ファイル、AGENTS.md）がすべて実在する | 配布物の構成（AGENTS.md の配布の節） |
| AC5 編集メモなし | pass | 変更した文書に `grep -nE '追記\|更新:\|変更:\|（.*更新）\|Updated\|Changelog'` を実行し、該当なし | 利用者の指示（既存の記述を直接書き換える） |
| AC6 文書のコマンドが動く | pass | R0 の `doctor` / `schema` / `check` / `plan` / `inspect` はすべて `ok:true`。`bun test` は 78 pass、`bun run typecheck` は通過。配布の形の確認で、導入先の `schema` が `ok:true` を返した | README の「使い方」、SKILL.md のコマンド表、AGENTS.md の「配布の形での確認」 |
| AC7 SKILL.md の長さと手順0 | pass | `wc -l` は 118 行。手順0の行を変更前の写しと `diff` し、差分なし | AGENTS.md の方針（500 行以内） |
| AC8 設計レビュー記録の削除 | pass | `docs/tool-design-review.md` は無い。`grep -rn tool-design-review` で該当するのは `docs/changes/` の中だけ | 利用者の決定（spec の未決事項1で「削除する」） |
| AC9 `schema` の `references` | pass | テスト `schema: the types, the guide, the references and the examples, from any directory`: 返したパスが `references/` の `.md` の集合と一致し、すべて実在する。既存の欄の確認も通る。配布の形では、導入先の `references/` の4ファイルを実体のパスで返した | `schema` の既存の契約（`ok`、`guide`、`examples`、`note`、`types` は名前も意味も変えない） |
| AC10 ヘルプと `doctor` | pass | テスト `usage: guards cover session start, run has a risk tier, schema lists the references, plan takes a scenario`。`doctor` の OpenScreen の修正案は、2つとも定数 `OPENSCREEN_VERIFIED`（2.2.0）から作る。`grep -rn '1\.13'` は該当なし | `render.ts:9,43`（2.2.0 で確認） |

## 検査

- 型: `bun run typecheck` 通過
- テスト: `bun test` 78 pass / 0 fail
- 差分の書式: `git diff --check` 通過
- lint: なし（このリポジトリに設定がない）
- 秘密情報: 追加行への `(api[_-]?key|secret|password|token)\s*[:=]` の照合で該当なし
- 依存: なし（`package.json` と `bun.lock` は変えていない）

## レビュー

別の文脈のレビュアー（サブエージェント）に、仕様と固定した差分（`git diff HEAD`、sha256 `5e35f42f…`）を渡してレビューした。

- 1回目: REQUEST_CHANGES。指摘は warning 1件。`doctor.ts` の2つ目の修正案（help の出力を認識できないとき）に「1.13+」が残っていた。直すべき修正案が2つあったのに、1つしか直していなかった。
- 対応: 版を定数 `OPENSCREEN_VERIFIED` に集め、2つの修正案をどちらもそこから作るようにした。`bun test`、型検査、`doctor` を再実行した。
- 2回目: APPROVE。指摘の解消と、ほかの差分が1回目から変わっていないこと（`doctor.ts` を除いた差分の sha256 の一致）を確認した。
- 採らなかった指摘: なし。レビュアーは2回目に、`1.13` が戻ったことを検出するテストを `doctor.test.ts` に足す案に触れた。版の文字列を1か所に集めたので、テストは足していない。

## 人の確認

`route-review.sh docs/ains/human-review-rules origin/main` の判定は `HUMAN_REQUIRED`（一致5件）。このブランチ全体（PR #9）が対象。

- `AGENTS.md`（エージェントの運用規則）: 今回の変更では「現行仕様の参照先」から `docs/tool-design-review.md` を消した。
- `skills/headless-demo-recorder/scripts/capture/*`、`package.json`、`docs/ains/human-review-rules`: このブランチの前のコミットによるもので、今回の変更では触れていない。

確認してほしい人: リポジトリの管理者（53able）。観点は次の2つ。

1. README から消したエージェント向けの規則が、`references/` の側で足りているか。
2. `docs/tool-design-review.md` を削除してよいか（当時の判断は git の履歴にだけ残る）。

## 利用者への有用性

- 人の利用者: README は、導入から使い方、レシピ、制約までを通して読める入口になった。文書の読みやすさは、利用者本人が確認する必要がある。確認はマージ前、管理者が行う。まだ確認していない。
- エージェント: `schema` だけで `references/` を見つけられる。ただし、実際のエージェントのセッションで `schema` から `references/` を読みに行くかは確かめていない。

## 未検証の範囲

- 実際の録画は行っていない。この変更で触れたコードは、`schema` の出力、ヘルプ、`doctor` の文字列だけで、録画・書き出し・`inspect` の経路は変えていない。AGENTS.md は、`capture/`、`render.ts`、`compile.ts`、`inspect.ts` を変えたときに実録画での確認を求めているが、今回はどれも変えていない。
- エージェントが新しい README と `references/` で正しく動くか（実際の依頼での確認）。

## 展開と切戻し

- 手段: `main` へのマージで、版を固定していない導入者に `npx skills update` で届く。届くかどうかはスキルフォルダの git ツリーハッシュで判定される。版を固定した導入者（`tree/vX.Y.Z`）には届かない。フラグや段階公開の仕組みは無い。
- 版: `package.json` は 0.3.1。マージ後、AGENTS.md の手順でマージコミットに `v0.3.1` のタグを打ち、GitHub Release を作る。README の版を固定した導入の例は、このタグを指している。
- 止める基準: 次のどちらかが起きたら止める。
  - `schema` の出力を読む利用者の仕組みが壊れたという報告。既存の欄は変えていないので、起きるとすれば欄を厳密に照合している場合だけ。
  - エージェントが `references/` の手順を見つけられずに失敗したという報告。
- 切戻し: `main` でマージコミットを revert し、利用者は `npx skills update` で戻る。版を固定した導入者には影響がない。
- 戻らない状態変更: なし。削除した `docs/tool-design-review.md` は git の履歴から復元できる。
- 展開後に見るもの: GitHub の Issue。自動の計測は無い。
