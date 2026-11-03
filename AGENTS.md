# headless-demo-recorder: 開発者向けメモ

- 運用ガイドの正本は `skills/headless-demo-recorder/SKILL.md`。このリポジトリ内で録画を試すときも SKILL.md の手順に従う。
- 配布は [skills](https://github.com/vercel-labs/skills) CLI（`npx skills add 53able/headless-demo-recorder`）で行う。`skills/headless-demo-recorder/` の中身（`SKILL.md`、`references/`、`scripts/`、`assets/`）がそのまま利用者の `.agents/skills/` や `~/.claude/skills/` に置かれ、リポジトリ直下・`tests/`・`demo/`・`docs/` は配られない。
  - CLI からスキルの外のファイルを参照しない。パスは `import.meta.url` 基準でスキルのディレクトリ内に閉じる。
  - 実行時の依存パッケージを足さない。導入先では `bun install` されず、`bun scripts/cli.ts` がそのまま動く必要がある。
  - `SKILL.md` の frontmatter の `name` はディレクトリ名と一致させる。
- CLI の実体は `skills/headless-demo-recorder/scripts/cli.ts`。リポジトリルートで `bun skills/headless-demo-recorder/scripts/cli.ts <command>` と呼ぶ。
- 型定義は `skills/headless-demo-recorder/scripts/types.ts`、example は `skills/headless-demo-recorder/assets/`（リポジトリルートを cwd にした形で書く。`bun test` が全件を検証する）。
- `SKILL.md` には毎回必要な手順だけを置き、session・file ソース・composition・Codex のサンドボックスのように一部の依頼でしか要らない手順は `references/` に置いて SKILL.md から読ませる。入力 JSON の形式と制約は `scripts/types.ts`（`schema` が返す）に書き、別の文書に写さない。
- テストは `bun test`、型検査は `bun run typecheck`。
- 実録画での確認: `scripts/capture/`、`render.ts`、`compile.ts`、`inspect.ts` を変えたときは、`bun test` に加えて実際に録画する。最低限、`assets/desktop-calculator.json` の `run` と、`edit.idleSpeedupMs` を付けた desktop の `session`（`start` → `observe` / `act` を数手 → `stop` → `render`）を行い、書き出した動画を `inspect --video <出力>` して、各コマの操作・マーカー・字幕が一致することを目視する。inspect の時刻のずれと agent-desktop の読み取り失敗は、単体テストでは見つからず実録画で初めて分かった。
- 配布の形での確認: 一時ディレクトリで `npx skills add <リポジトリの絶対パス> --skill headless-demo-recorder -a claude-code -a codex -y` を実行し、`bun .agents/skills/headless-demo-recorder/scripts/cli.ts schema` が `ok:true` を返すことを確かめる。
- リリース: バージョンは `package.json` の `version` だけに書く。利用者から見える変更を含む PR の中で上げ（0.x のあいだは、既定の挙動を変えるならマイナー、修正だけならパッチ）、スカッシュマージ後にそのマージコミットへ注釈付きタグ `vX.Y.Z` を打って push する（`git tag -a vX.Y.Z <merge-commit> -m "vX.Y.Z: <PR の件名>"`、`git push origin vX.Y.Z`）。続けて GitHub Release を作る（`gh release create vX.Y.Z --verify-tag --title vX.Y.Z --notes-file <ノート>`）。ノートには概要、既定の挙動の変更と戻し方、変更点、既知の問題、版を固定した導入コマンドを書く（形は v0.3.0 の Release に合わせる）。
  - `npx skills update` はバージョン番号を見ない。スキルフォルダの git ツリーハッシュを既定ブランチと比べるので、`main` へのマージがそのまま既定の導入者に届く。`package.json` だけの変更は届かない。
  - タグは版を固定した導入（`npx skills add https://github.com/53able/headless-demo-recorder/tree/vX.Y.Z/skills/headless-demo-recorder`）に使われる。固定した導入は `skills update` でもそのタグに留まる。スキルが `skills/` に移ったのは v0.2.0 からなので、v0.1.0 はこの形では導入できない。

## Agent skills

- 検査：`bun test`、`bun run typecheck`（タスクと変更を閉じる前に実行する）。録画関連の変更は、上記の実録画での確認も行う。
- 変更ごとの仕様・計画・タスクの置き場所：`docs/changes/`
- 人の確認が必須の変更：`docs/ains/human-review-rules`（ains-review-gate がマージ前に判定する。ローカルの編集・検査は妨げない）
- AIに任せる操作：編集、ローカルの検査。コミットなど追加の操作には、その操作と範囲への明示的な許可が必要。既に明示された許可は、その範囲で保持する。
- 外向き操作（push、PR、マージ、デプロイ、外部への送信、本番データの変更）：人の指示で行う。例外は、利用者が操作と範囲を明示的に許可した tasks.md の「任せる範囲」と、チームが明示的に許可した自動統合の段階だけ。過去の個別依頼を恒久的な許可に広げない。
- 止まったときの相談先：作業を依頼した人
- 費用・時間の上限：未設定
- 現行仕様の参照先：運用ガイドの正本は `skills/headless-demo-recorder/SKILL.md`、入力 JSON の形式・制約の正本は `skills/headless-demo-recorder/scripts/types.ts`。
- スキル起動：手動段階の製品ネイティブ起動は利用者の明示的なコマンドに限る。通常の Read/Bash 等での手順・資産の参照は依頼と権限の範囲で行え、追加承認は不要。推奨や approved は次のネイティブ起動の指示ではなく、起動設定・参照は操作の許可や仕様・計画の承認を与えない。
- 次に何をするか迷ったら Claude Code では `/ains`、Codex では `$ains`
