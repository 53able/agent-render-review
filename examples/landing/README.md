# examples/landing

Render Director の ADE モードを試すための静的ページです。ヒーロー画像は `public/vork/hero.png` を参照しています（最初は存在しません）。

```sh
# 1. ページを配信（例）
npx serve examples/landing/public -l 5173
# 2. このディレクトリで ADE のエージェントに MCP を登録して「ヒーロー画像を作って」と依頼する
```

`.vork/config.json` に `"pageUrl": "http://127.0.0.1:5173/"`, `"assetUrlPattern": "**/vork/hero.png"` を書くと、Director で候補をページ上に当てはめて比較できます。
