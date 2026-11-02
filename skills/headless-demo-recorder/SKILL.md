---
name: headless-demo-recorder
description: ブラウザや macOS アプリをヘッドレスで操作しながら録画し、ズーム・カーソル・字幕・ぼかしを付けた MP4/GIF のデモ動画を人手を介さずに作る。複数の録画を同時に撮って1本に結合したり、録画済みの動画に後から編集を足したりもできる。Use when the user asks for a demo, walkthrough, or screen-recording video of a web page or a macOS app, or wants zoom/captions/blur added to an existing screen recording. Don't use for live screen sharing, manual GUI video editing, or recording outside macOS.
---

# headless-demo-recorder

コマンドは `headless-demo-recorder <command>`。各コマンドは stdout に JSON を1つだけ出す。コマンドが見つからなければ、利用者に README の「セットアップ」を案内して止める。

## 手順
1. `headless-demo-recorder doctor` を実行する。`ok:false` の項目があれば止めて、その `fix` を利用者に伝える（OS の権限やツールの導入は利用者が行う）。
2. `headless-demo-recorder schema` を実行する。返る `guide`（AGENTS.md の絶対パス）が作業手順とガードレールの正本なので、最初に読む。`types` が入力 JSON の形式、`examples` が例のシナリオ。
3. guide の作業ループ（下見 → シナリオを書く → `check` → `run` → inspect-sheet を目視 → 必要なら `render --force`）に従う。
4. シナリオと出力は、いま作業しているプロジェクトに置く（例: `demo/<name>.json`、`out/<name>.mp4`）。シナリオ内のパスはカレントディレクトリからの相対になる。出力先が `.gitignore` に入っていなければ、録画に画面がそのまま入ることを添えて利用者に伝える。

## 注意
- Codex のサンドボックスでは、`doctor`・`capture`・`run`・`render` と下見の `agent-browser` / `agent-desktop` を、最初からサンドボックス外で実行する許可を求める（中で実行すると openscreen がクラッシュする）。
- 実際に削除・送信・購入などを行うシナリオ（`allowDestructive`）は、利用者の承認を得てから実行する。
