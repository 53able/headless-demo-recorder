---
status: approved
---

# 2026-11-03-docs-refresh

## 目的

文書を読んだ利用者とエージェントが、現在のコードと一致した手順だけを目にする。同じ事実は1か所にだけ書かれ、詳しい手順はそれを持つ文書へのリンクでたどれる。エージェントは `schema` の出力だけで、毎回読む手順（SKILL.md）と、依頼に応じて読む手順（`references/`）の両方を見つけられる。

## 文脈

- 文書は4種類。役割は次のとおり。
  - `README.md`（人の利用者向け、約330行）
  - `skills/headless-demo-recorder/SKILL.md` と `references/*.md`（エージェント向けの正本。SKILL.md は毎回読まれ、references は依頼に応じて読まれる）
  - `AGENTS.md`（開発者向け）
  - `docs/tool-design-review.md`（設計レビューの記録）
- 入力 JSON の形式と制約の正本は `scripts/types.ts`（`schema` が返す）。検証の正本は `scripts/validate.ts`。
- 2026-11-03 にコードと文書を突き合わせた。主な食い違いは次のとおり（行番号は調査時点のもの）。
  - 誤り: README が存在しない `.omc/research/ac3-desktop-typing.md` を根拠として挙げている。desktop で `launch: false` のとき `app` に何を書くかがどこにもない（`launch: true` のときだけローカライズ名に置き換わる）。`--allow-origin` / `--allow-app` が `session start` にも効くことが、README、ヘルプ、SKILL.md の表から抜けている。
  - 古い記述:
    - マーカーを付けない対象（redact のすべてのイベント）
    - 早送りが始まる条件（操作の後 1.2 秒、次の操作の前 0.6 秒を残す）
    - composition で使えない `idleSpeed`
    - OpenScreen の基準版（文書は 1.13、コードは 2.2.0 で確認）
    - inspect の `timelineEdited` / `note` と `render.json`
    - `plan` / `render` のフラグ
    - `--session-name` / `--keep-work`
    - `session status` の状態
    - `run` のリスク区分
    - README の版の固定（v0.3.0）
    - README のコマンドの略記の不一致
    - 説明動画の stderr の記述
  - 重複: Codex のサンドボックス（3か所）、マーカーの規則、配布の単位と導入の確認、新しいタブ・ドラッグ・単語リスト・出力解像度・待ち時間の上限が、README と SKILL.md / references の両方にある。
  - 構成: `schema` の `guide` は SKILL.md だけを返し、references に触れない。README は SKILL.md を正本と呼ぶが、references を挙げていない。
  - `docs/tool-design-review.md` には、今は無い振る舞いが書かれている（desktop の scroll の拒否、早送り時のコマの時刻はおおよそ、など）。
- `demo/howto/` が使うパスとコマンドは、すべて現在も存在する。
- `docs/tool-design-review.md` を参照しているのは README（「設計の根拠」）と AGENTS.md（「現行仕様の参照先」）の2か所。

## 制約

- 既存の記述を直接書き換える。「追記」「更新」「変更履歴」などの編集メモを本文に残さない。履歴は git に任せる（利用者の指示）。
- 形式と制約は `scripts/types.ts` に書き、文書には写さない（AGENTS.md の方針）。
- SKILL.md は 500 行以内。毎回は要らない手順は `references/` に置く（AGENTS.md の方針）。
- 文書の言語は日本語のまま。コマンド、フラグ、識別子は原文どおり。
- README は人の利用者の入口に絞る。概要、導入、使い方の入口、レシピ、既知の制約の要約を置き、エージェント向けの細かい規則は SKILL.md / `references/` にだけ書いて README からリンクする（利用者の決定）。
- `schema` の出力には欄を足すだけにし、既存の欄（`ok`、`guide`、`examples`、`note`、`types`）の名前と意味は変えない。`schema` を読む既存のエージェントを壊さないため。

## 受入条件

- [ ] AC1: 調査で「誤り」とした3件が直っている。 — 検証:
  - README に `.omc/research/` への参照がない（`grep`）。
  - desktop の `launch: false` で `app` に書く名前が、types.ts の型コメントか SKILL.md に書かれている。
  - `--allow-origin` / `--allow-app` が `session start` に効くことが、README と SKILL.md の表に書かれている。
- [ ] AC2: 調査で「古い記述」とした12件が、コードと一致している。 — 検証: 調査の各項目について、文書の該当箇所と、根拠としたコードの行を突き合わせた表を PR に載せる。
- [ ] AC3: 調査で「重複」とした事実が、それぞれ1か所にだけ書かれ、ほかの文書はそこへリンクしている。 — 検証: 重複として挙げた語（`NEW_TAB`、`--headed`、`Operation not permitted`、`idle-timeout`、`1784x1080` など）を `grep` し、本文での説明が1か所であることを確かめる。
- [ ] AC4: README から、エージェント向けの正本（SKILL.md と `references/`）へたどれる。 — 検証: README の該当リンクを開き、各 references のファイルに届くことを確かめる。
- [ ] AC5: 文書に編集メモがない。 — 検証: 変更した文書を `grep -nE '追記|更新:|変更:|（.*更新）|Updated|Changelog'` し、該当がない。
- [ ] AC6: 文書に書いたコマンドが動く。 — 検証: 以下を実行する。
  - README の使い方の節と、SKILL.md のコマンド表にあるコマンドのうち R0 のもの（`doctor`、`schema`、`check`、`plan`、`inspect`）。
  - `bun test` と `bun run typecheck`。
  - AGENTS.md の「配布の形での確認」。
- [ ] AC7: SKILL.md は 500 行以内で、手順0の振り分けが変わっていない。 — 検証: `wc -l`。手順0の行を変更前と比べる。
- [ ] AC8: `docs/tool-design-review.md` が無く、どの文書もそれを参照していない。 — 検証: ファイルが無いことと、`grep -rn tool-design-review` がリポジトリ（`docs/changes/` を除く）で何も返さないこと。
- [ ] AC9: `schema` が `references/` の各ファイルの実体のパスを返し、既存の欄は変わらない。 — 検証:
  - `cli.test.ts` の `schema` のテストで、返したパスがすべて存在し、`references/` の `.md` ファイルの集合と一致することを確かめる。既存の欄（`ok`、`guide`、`examples`、`note`、`types`）の確認も残す。
  - 配布の形（一時ディレクトリに導入）で `schema` を実行し、返ったパスが導入先の `references/` を指すことを確かめる。
- [ ] AC10: CLI のヘルプと `doctor` の修正案が、文書と同じ事実を示す。 — 検証: `bun scripts/cli.ts help`（または引数なし）の出力で、`--allow-origin` / `--allow-app` が `session start` にも効くこと、`run` にリスク区分があることを確かめる。`doctor.ts` の OpenScreen の修正案の版が、`render.ts` のコメントが確認済みとする版と一致する。

## 対象外

- CLI の振る舞いの変更。ただし `schema` に `references` の欄を足すことと、ヘルプと `doctor` の文字列の修正は含む（利用者の決定）。
- 説明動画の録り直し（`demo/howto/` は動くことを確かめるだけにする）。
- v0.3.1 のタグと GitHub Release の作成（マージ後の別作業）。
- 英語版の文書の作成。

## 観測された契約

- `schema` の出力は `{ ok, guide, examples, note, types }`。`guide` は SKILL.md の実体のパス（`cli.ts:454`）。
- desktop で `launch: true` のときは、`launch` の結果のローカライズ名で窓を探す。そうでないときは `source.app` をそのまま `app_name` と比べる（`capture/desktop.ts:69-76`）。

## 未決事項

（なし）
