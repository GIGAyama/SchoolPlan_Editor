# デモ動画の素材と後処理

OAuth 審査用デモ動画（[C5 撮影台本](../C5_DEMO_VIDEO_SCRIPT.md)）の素材と、
撮影後の編集手順をまとめます。

## ファイル

| ファイル | 中身 |
|---|---|
| `demo_en.srt` | 英語字幕。**いまの台本（[C5](../C5_DEMO_VIDEO_SCRIPT.md) の11シーン）の全文**が入っています。ただし**時刻は台本の想定尺から置いた仮の値**なので、そのままアップロードしないでください |
| `demo_en_cues.json` | 上の元データ（開始・終了と英文）。撮影後、実際の映像に合わせて時刻を直します |

```bash
# 台本を書き換えたら、字幕の文面をそこから作り直す（時刻は仮）
node tools/demo-video/build-srt.mjs --from-scenes

# 実際の映像を見て demo_en_cues.json の時刻を直したら、.srt を再生成
node tools/demo-video/build-srt.mjs
```

> ⚠️ 2026-08-15 撮影の動画（6分42秒）に合わせた字幕は**破棄しました**。
> 台本が11シーンに増え、当時の映像とは対応しなくなったためです。

> 🤖 [`tools/demo-video/`](../../tools/demo-video/README.md) の撮影スクリプトで撮った場合は、
> 実測タイミングの `.srt` が `dist/demo-video/` に直接出るので、この手順は不要です。
> **その `.srt` をそのまま YouTube に上げるのが一番確実です。**

## 役割分担

**あなたがやること：素材の録画だけ**

C5 の台本どおりに操作し、**編集せず撮りっぱなし**で録画してください。
言い間違いや操作のやり直しがあっても、そのまま撮り続けて構いません（あとでカットできます）。
唯一カットしてはいけないのは**シーン3（OAuth 同意フロー）**です。ここだけは
ログイン → アカウント選択 → 同意 → アプリ表示を一続きで撮ってください。

**そのあとの編集は、この文書の手順で処理できます。**

## 素材の受け渡し

GitHub のブランチに push するのが確実です。

```bash
# 録画ファイルを raw/ に置いて push（GitHub の上限は 100MB）
mkdir -p docs/video/raw
cp ~/Desktop/recording.mp4 docs/video/raw/
git add docs/video/raw/recording.mp4
git commit -m "chore: デモ動画の素材を追加"
git push -u origin claude/google-auth-demo-video-8cj1lq
```

> ⚠️ 100MB を超える場合は、録画時にビットレートを下げるか、先に圧縮してください。
> 13分の1080p画面録画なら、下の「事前圧縮」コマンドで十分小さくなります。
>
> ⚠️ **素材には撮影用ダミーデータしか映っていないことを、push 前に必ず確認してください。**
> 実在の児童・保護者情報が入った動画をリポジトリに置くと、履歴から消すのが大変です。

```bash
# 事前圧縮（画質を保ちつつサイズを落とす）
ffmpeg -i recording.mp4 -vf scale=1920:-2 -c:v libx264 -crf 26 -preset slow -c:a aac -b:a 96k compressed.mp4
```

## 後処理でできること

### 1. 字幕（必須要件）

**YouTube に .srt を直接アップロードするのが最も簡単で、画質も落ちません。**
YouTube Studio →「字幕」→「言語を追加」→ English →「ファイルをアップロード」で `demo_en.srt` を指定します。

焼き込みたい場合：

```bash
ffmpeg -i raw.mp4 -vf "subtitles=demo_en.srt:force_style='FontSize=18,PrimaryColour=&H00FFFFFF,BackColour=&H80000000,BorderStyle=3,MarginV=30'" -c:v libx264 -crf 20 -preset slow -c:a copy with_subs.mp4
```

### 2. 個人情報のぼかし

映り込んだメールアドレスやブックマークバーを、座標指定でぼかせます。

```bash
# x=100, y=200 から幅400・高さ40 の領域を、10秒〜25秒の間だけぼかす
ffmpeg -i raw.mp4 -vf "boxblur=20:enable='between(t,10,25)':eval=frame" -c:a copy blurred.mp4
```

> 実際には対象の座標をフレームから確認してから指定します。

### 3. 不要部分のカット・結合

```bash
# 0:12〜5:40 だけを切り出す
ffmpeg -i raw.mp4 -ss 00:00:12 -to 00:05:40 -c copy trimmed.mp4

# 複数クリップを結合（list.txt に file 'clip1.mp4' の形式で列挙）
ffmpeg -f concat -safe 0 -i list.txt -c copy joined.mp4
```

### 4. 提出前の自動チェック

同意画面のフレームを静止画で抜き出し、`client_id` が実際に読めるかを目視で確認します。
**差し戻し理由の筆頭がこれ**なので、提出前に必ず実施してください。

```bash
# シーン3（OAuth 同意画面）のあたりを1秒ごとに静止画化。
# 台本どおりなら1分40秒〜2分40秒あたりだが、実際の映像で位置を確かめてから指定する。
mkdir -p frames
ffmpeg -i final.mp4 -ss 00:01:40 -to 00:02:40 -vf fps=1 frames/consent_%03d.png
```

抜き出した PNG を開き、アドレスバーの `client_id=` が読み取れるか確認します。
読めなければ、ウィンドウを最大化して**シーン3だけ撮り直し**です
（撮り直しの前に https://myaccount.google.com/permissions でアクセス権の削除が必要）。

### 5. 最終書き出し

```bash
ffmpeg -i edited.mp4 -vf scale=1920:1080 -c:v libx264 -crf 20 -preset slow -pix_fmt yuv420p -c:a aac -b:a 128k final_1080p.mp4
```

## 提出

書き出した動画を YouTube に **「限定公開（Unlisted）」** でアップロードし、
シークレットウィンドウで再生できることを確認してから、C4 の申請フォームに URL を貼ります。
詳細は [C5 台本の §4](../C5_DEMO_VIDEO_SCRIPT.md) を参照してください。
