# 複数の録画を同時に行い、1本に結合する（composition）

既存のシナリオを 1〜2 本参照する構成ファイル（スキーマは `scripts/types.ts` の `Composition`、例は `assets/composition-calc-wiki.json`）を書き、`check` → `run` → `inspect` は単一シナリオと同じ手順で行う。

1. 参照先のシナリオは先に単体で `check` を通し、下見を済ませておく。`check <composition>` は参照先の検証も含めて1つの JSON で返す。
2. `--allow-origin` / `--allow-app` は参照先すべてに掛かる。desktop を2本録るなら両方のアプリを列挙する。
3. 参照先は同時に録画を開始し、あとは独立に進む。ステップ単位の待ち合わせ（A の操作を B が待つ）はできない。
4. `inspectSheet` では、各場面の切り替わり（`events.json` の `scene N:` の mark）と、左右それぞれのセルに字幕とマーカーが出ていることを確かめる。
5. 修正は参照先の `events.json` か composition の `scenes` / `edit` を直し、`render <compProj> --composition <file> --force` で結合だけをやり直す。

## 結合のされ方

- `scenes` は順に再生される。`single` は1本を全面に、`side-by-side` は2本を左右に並べる。各 stream は `startMs` / `endMs`（開始時刻を揃えた後の録画上の時刻）で区間を切れる。
- 出力フレームは `size`（既定 1920x1080）。録画はセルに収まるよう縦横比を保って拡縮し、余白は暗色で埋める。
- ズームの設定と字幕の大きさは参照先の `scenario.edit` が既定で、`composition.edit` の同名キーで上書きする。マーカーとカーソルの規則は SKILL.md の「マーカーとカーソル」。`titles` と `style` は composition の `edit` にだけ書ける。参照先の `scenario.edit.redact` は、録画上の時刻から各場面の時刻へ直して適用する。
- ズームは出力全体に1つしか掛からない。左右並べで2本のズームの時刻が重なったときは、先に始まった方を採り、後の方は捨てる。片方のセルにズームしている間、もう片方のセルはほぼ画面外に出る。
- 結果 JSON には、単一シナリオと同じ欄に加えて `projectDirs`（参照先の project）と `startSkewMs`（録画開始の時刻の差。実測 100〜400ms）が入る。合成後の project（`out/<name>.project/`）の `events.json` は派生物で、`render` のたびに上書きされる。手で直すのは参照先の `events.json`。

## 失敗したとき

- 片方の録画開始や file 入力の準備が失敗すると、もう片方もシナリオのステップを実行する前に止まる。開始の待ち合わせが120秒を超えた場合も止まる。ページやアプリの起動、録画の開始までは行われることがある。
- `CAPTURE_PARTIAL_FAILED`（`retry: no`）のときは、アプリの状態を戻してから `run <composition> --force` で全本を撮り直す。別の実行で撮った録画は開始時刻を揃えられない（`runId` が違う）ので、1本だけ撮り直して結合しない。
- 参照先の `scenario.edit` のうち、時間を変える `trim` / `idleSpeedupMs` / `idleSpeed` と `speechCaptions` は composition では使われず、`check` が warning を出す。composition 自体の `edit` に書けるキーは `scripts/types.ts` の `CompositionEdit` に従う。
- composition の `output.path` は、既存の単一シナリオの project と重ねない。重なると `PROJECT_COLLISION` で止まる。
