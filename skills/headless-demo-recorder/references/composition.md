# 複数の録画を同時に行い、1本に結合する（composition）

既存のシナリオを 1〜2 本参照する構成ファイル（スキーマは `scripts/types.ts` の `Composition`、例は `assets/composition-calc-wiki.json`）を書き、`check` → `run` → `inspect` は単一シナリオと同じ手順で行う。

1. 参照先のシナリオは先に単体で `check` を通し、下見を済ませておく。`check <composition>` は参照先の検証も含めて1つの JSON で返す。
2. `--allow-origin` / `--allow-app` は参照先すべてに掛かる。desktop を2本録るなら両方のアプリを列挙する。
3. 参照先は同時に録画を開始し、あとは独立に進む。ステップ単位の待ち合わせ（A の操作を B が待つ）はできない。
4. `inspectSheet` では、各場面の切り替わり（`events.json` の `scene N:` の mark）と、左右それぞれのセルに字幕とマーカーが出ていることを確かめる。
5. 修正は参照先の `events.json` か composition の `scenes` / `edit` を直し、`render <compProj> --composition <file> --force` で結合だけをやり直す。

- `CAPTURE_PARTIAL_FAILED`（`retry: no`）のときは、アプリの状態を戻してから `run <composition> --force` で全本を撮り直す。別の実行で撮った録画は開始時刻を揃えられない（`runId` が違う）ので、1本だけ撮り直して結合しない。
- composition の `output.path` は、既存の単一シナリオの project と重ねない。重なると `PROJECT_COLLISION` で止まる。
