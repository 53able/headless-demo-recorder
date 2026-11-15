# 外部ツールの版を、確かめた範囲で使わせる

## 背景
`doctor` は agent-browser と agent-desktop の下限の版だけを検査していた。これには次の4つの問題があった。

- **下限が古い**: agent-desktop の下限 1.0.2 は、今のコードで確かめた版ではなかった。`press` やウィンドウ、タブのガードは 1.3.0 の挙動を実測して作った。
- **新しい版に気づけない**: スキルが確かめた版より新しい版を使っていても、何も知らせなかった。どちらのツールもマイナー版で挙動が変わる。実際に、agent-browser 0.42.0 で WebSocket の定数を補う仕組みが効かなくなっていた（下の「新しい版での確認」）。
- **版の数字がずれうる**: README、`doctor.ts`、SKILL.md に版の数字が別々に書かれていた。
- **`doctor` が必ず失敗していた**: agent-desktop 1.3.0 の `version` の出力は `{"version":"2.6", …, "data":{"version":"1.3.0"}}` の形で、`doctor` は先頭の envelope の版 `2.6` を読んでいた。`2.6` は x.y.z の形でないので、agent-desktop 1.3.0 の環境では `doctor` が必ず `ok:false` になっていた（実測）。

## 変更
1. `scripts/doctor.ts`
   - 版の数字の正本 `TOOL_VERSIONS` を置き、ツールごとに `min` と `verified` を持たせた。
     - `min`: 今のコードで確かめた最も古い版。これより古いと失敗する。
     - `verified`: 実録画での確認と、SKILL.md の版ごとの記述を確かめた最も新しい版。これより新しいと `ok` のまま `warning` を返す。
   - agent-desktop は `min` と `verified` をどちらも 1.3.0 にした。agent-browser は `min` 0.41.0、`verified` 0.43.0。agent-desktop の `verified` は 1.3.1。どちらも、下の「新しい版での確認」を通した版。
   - agent-desktop の版を `data.version` から読むようにした（`agentDesktopVersion`）。
   - 下限より古いときの修正案は、`@latest` ではなく確かめた版を指定する形（`npm i -g <tool>@<verified>`）にした。版を読めないとき（新しい版で出力の形が変わった場合など）は、版下げを勧めず、出力を示して失敗にする。envelope の版を代わりに読むこともしない。
   - プレリリース版（`-beta` など）は `ok` のまま `warning` を返す。
2. `doctor` の結果に `warnings` を加えた（`cli.ts`）。
   - `doctor` は実行のたびに npm レジストリ（`https://registry.npmjs.org/<tool>/latest`、5秒で打ち切り）へ最新版を問い合わせる（`npmLatest`、`latestCheck`）。最新版が `verified` より新しいとき、または手元の版より新しいときに `warning` を出す。失敗にはしない。問い合わせできないとき（オフライン、サンドボックス）は、警告なしで「unknown」とする。SKILL.md の手順は作業の最初に必ず `doctor` を実行するので、スキルを使うたびに気づける。
3. SKILL.md: `warnings` は止める理由にならないこと、利用者にツールと版を伝えて続けること、手順5の確認を全コマで4点すべて見ること、版の違いによると思われる失敗はツールと版を添えて報告することを書いた。
4. README の必要環境: 下限と確かめた版の両方を書いた。`tests/versions.test.ts` が、README の版の数字と `TOOL_VERSIONS` の一致を確かめる。
5. AGENTS.md: 新しい版で実録画での確認を通したら `verified` を上げ、「○○で実測」の記述を確かめ直す手順を書いた。

## 確認
- `bun test`: 93 件すべて通過。
- `bun run typecheck`: 通過。
- この開発機での `doctor`: `ok:true`、`warnings` なし（agent-browser 0.43.0、agent-desktop 1.3.1）。変更前は agent-desktop の版の項目が `ok:false` だった。

## 新しい版での確認（agent-browser 0.43.0、agent-desktop 1.3.1）
- `bun test` がすべて通過。session のテストと `tests/ws-constants.test.ts` は実物の agent-browser を動かす。
- AGENTS.md の実録画での確認（計算機の `run`、`edit.idleSpeedupMs` 付きの desktop session、`inspect --video`）で、全コマの操作・マーカー・字幕が一致した。
- agent-desktop 1.3.1: `press --window-id` が背面のウィンドウに送らないこと、`list-windows` の `accessible` の欄、`version` の出力の形、Terminal のガードが録画の前に止まることを確かめた。
- agent-browser 0.43.0: ref の3つの書き方、`tests/integration/ab-ports.ts`（記録どおり）、新しいタブを開くクリックで `about:blank` になること（0.43.0 は約10秒後にエラーを返す）を確かめた。
- **0.42.0 からの退行を見つけて直した**: `--allowed-domains` のもとで、agent-browser 0.42.0 以降は読み込みの後にもう一度 `window.WebSocket` を差し替えるため、`ws-constants.js` が補った定数が消えていた（0.41.1 では残る。3つの版で実測）。読み込みから 1.5 秒後に WebSocket を開くページは、0.42.0 と 0.43.0 で何も送れなかった。`ws-constants.js` は `window.WebSocket` をアクセサにして、後から代入された `WebSocket` にも定数を補うようにした。0.41.1 と 0.43.0 で送信が届くことを確かめ、回帰テスト `tests/ws-constants.test.ts` を加えた（古い `ws-constants.js` では失敗する）。

## 人の確認
- `AGENTS.md` を変えたので、`docs/ains/human-review-rules` によりマージ前に人の確認が要る。
- リリースノートの「既定の挙動の変更と戻し方」に、agent-desktop の下限を 1.3.0 に上げたこと（戻すには 0.3.x を版を固定して導入する）を書く。

## 未決事項
- agent-desktop の下限を 1.3.0 に上げたので、1.0.2〜1.2.x の利用者は `doctor` で止まる。既定の挙動の変更なので、0.4.0（この PR の版）に含める。
- `verified` を上げる作業は手作業。新しい版に気づけるのは `doctor` を実行したとき（スキルを使うたび）で、誰もスキルを使わなければ気づけない。OpenScreen は npm で配られていないので、問い合わせの対象外（形式の変化は書き出し前の `openscreen info` の検証で止める）。
