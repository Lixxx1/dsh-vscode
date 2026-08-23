# DeepSeek Harness for VS Code 🐋

> [!NOTE]
> ⭐ DSH Sidebar が気に入ったら、[GitHub でスターを付けてください](https://github.com/Lixxx1/dsh-vscode)！より多くの人にこのプロジェクトを届けられます。

DeepSeek Harness を、実際にコードを書く場所へ。dsh-vscode は Claude Code や Codex のような右サイドバーを DSH に提供し、プロジェクト・開いているファイル・選択中のコードを最初から理解した状態で動きます。

エディタ、ターミナル、別のチャットウィンドウを行き来することなく、DeepSeek にコードの調査・変更・検証を任せられます。

👋 このプロジェクトを作ったのは、自分自身が DSH をエディタのすぐ隣に置いておきたかったからです。同じように感じる方は、ぜひ試してみてください！使い心地もぜひ聞かせてください。

[English](README.md) | [简体中文](README.zh.md) | **日本語**

[Web サイト](https://lixxx1.github.io/dsh-vscode/) · [VS Code Marketplace](https://marketplace.visualstudio.com/items?itemName=lixxx1.dsh-sidebar)

[![CI](https://github.com/Lixxx1/dsh-vscode/actions/workflows/ci.yml/badge.svg)](https://github.com/Lixxx1/dsh-vscode/actions/workflows/ci.yml)
[![VS Code Marketplace](https://img.shields.io/visual-studio-marketplace/v/lixxx1.dsh-sidebar?style=flat-square&label=VS%20Code%20Marketplace&color=4d6bfe)](https://marketplace.visualstudio.com/items?itemName=lixxx1.dsh-sidebar)
[![MIT License](https://img.shields.io/badge/license-MIT-263146?style=flat-square)](LICENSE)
![Status](https://img.shields.io/badge/status-alpha-7da1de?style=flat-square)

<p align="center">
  <img src="media/demo.gif" alt="VS Code のサイドバーで動作する DeepSeek Harness">
</p>

## ✨ 特長

- **VS Code の中で公式の DSH をそのまま。** セッション、ストリーミング応答、ツール呼び出し、承認、追加の質問はすべて公式 DSH ランタイム上で動作します。
- **プロジェクトを理解したエディタコンテキスト。** 開いているファイル、選択中のコード、`@file` や `@folder` の参照がプロンプトと一緒に送られます。
- **必要な場所にセッション操作を。** Permission モードと Plan モードの切り替え、Model と Reasoning Effort の選択、実行中タスクの軌道修正ができます。
- **ネイティブなレビューと安全な取り消し。** VS Code の Diff Editor で変更を確認して Keep または Revert を選べます。未保存の変更があるファイルを上書きする前に DSH を停止します。
- **サイドバーから DSH を拡張。** DSH が読み込む Tools、Skills、MCP 連携、Memory、Agent Hooks を検索・管理できます。

## 📦 インストール

まず公式の DeepSeek Harness CLI をインストールします:

```sh
npm install -g @deepseek-ai/dsh
```

次に、用途に合った拡張機能のチャンネルを選びます。

### 公開リリース版

VS Code で**拡張機能**を開き、**DSH Sidebar** を検索して**インストール**を選択します。[VS Code Marketplace](https://marketplace.visualstudio.com/items?itemName=lixxx1.dsh-sidebar) から直接インストールすることもできます。

### 最新の開発ビルド

`main` にはすでに入っているものの Marketplace には未公開の機能を試したい場合は、最新の VSIX をビルドしてインストールします:

```sh
git clone https://github.com/Lixxx1/dsh-vscode.git
cd dsh-vscode
pnpm install --frozen-lockfile
pnpm run package
```

VS Code のコマンドパレットから **Extensions: Install from VSIX...** を実行し、`dsh-vscode.vsix` を選択してください。開発ビルドは更新が速い分、安定性は劣る場合があります。更新するには最新の変更を取得して VSIX を再ビルドしてください。

VS Code 1.100 以降と Node.js `^22.19` または `>=24` が必要です。

コミュニティ製のランタイムプラグインをインストールする場合は、`pnpm` が PATH に通っている必要があります。

## 🚀 使い方

1. 信頼済みのプロジェクトフォルダを VS Code で開きます。
2. 右サイドバーで **DeepSeek Harness** を選択します。表示されていない場合は **その他のビュー** から探してください。
3. 鍵アイコンのボタンから `DEEPSEEK_API_KEY` を設定します。
4. Permission モード、Model、Reasoning Effort を選んで作業を開始します。Permission モードと Plan モードの切り替えは Shield メニュー、DSH 公式のコマンドは `/`、ファイルやフォルダの追加は `@` から行えます。
5. サイドバーのタイトルにあるプラグインボタンから、コミュニティ製ランタイムプラグインの検索・インストール・確認・削除ができます。

💬 使いにくい点や「次はこれが欲しい」というアイデアがあれば、[Issue を立ててください](https://github.com/Lixxx1/dsh-vscode/issues)。いただいたフィードバックはすべて読んでいます。PR も歓迎です。

## License

[MIT](LICENSE)
