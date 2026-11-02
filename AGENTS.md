# headless-demo-recorder: 開発者向けメモ

- 運用ガイドの正本は `skills/headless-demo-recorder/SKILL.md`。このリポジトリ内で録画を試すときも SKILL.md の手順に従う。
- 配布は [skills](https://github.com/vercel-labs/skills) CLI（`npx skills add 53able/headless-demo-recorder`）で行う。`skills/headless-demo-recorder/` の中身（`SKILL.md`、`scripts/`、`assets/`）がそのまま利用者の `.agents/skills/` や `~/.claude/skills/` に置かれ、リポジトリ直下・`tests/`・`demo/`・`docs/` は配られない。
  - CLI からスキルの外のファイルを参照しない。パスは `import.meta.url` 基準でスキルのディレクトリ内に閉じる。
  - 実行時の依存パッケージを足さない。導入先では `bun install` されず、`bun scripts/cli.ts` がそのまま動く必要がある。
  - `SKILL.md` の frontmatter の `name` はディレクトリ名と一致させる。
- CLI の実体は `skills/headless-demo-recorder/scripts/cli.ts`。リポジトリルートで `bun skills/headless-demo-recorder/scripts/cli.ts <command>` と呼ぶ。
- 型定義は `skills/headless-demo-recorder/scripts/types.ts`、example は `skills/headless-demo-recorder/assets/`（リポジトリルートを cwd にした形で書く）。
- テストは `bun test`、型検査は `bun run typecheck`。
- 配布の形での確認: 一時ディレクトリで `npx skills add <リポジトリの絶対パス> --skill headless-demo-recorder -a claude-code -a codex -y` を実行し、`bun .agents/skills/headless-demo-recorder/scripts/cli.ts schema` が `ok:true` を返すことを確かめる。
