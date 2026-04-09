# IPCoder

Offline-first mobile code editor for Android built with React Native (Expo) and a locally bundled CodeMirror 6 instance.

## Stack

- React Native + Expo
- `react-native-webview` for editor surface
- `expo-file-system/legacy` for local file I/O
- `@react-native-async-storage/async-storage` for settings and recent files
- Local fonts: Space Grotesk + JetBrains Mono
- Local CodeMirror bundle: `assets/editor/codemirror.bundle.txt`

## Core Features

- Brutalist terminal UI (black/white/green/red palette, hard separators, zero radius)
- File Manager with breadcrumb navigation and local directory browsing
- Recent files list (max 20 persisted entries)
- Multi-tab editor (max 8 tabs) with unsaved `*` indicator
- Toolbar actions: Undo, Redo, Search, Word Wrap, Indent, Comment, Theme toggle
- Inline Search Palette with search/replace + case/regex/whole-word toggles
- Bottom status bar: language, UTF-8, tab size, Ln/Col
- Settings screen with categorized toggles and reset-to-defaults

## Local Development

```bash
npm install
npm run build:editor
npm run android
```

`npm run android` and `npm start` automatically regenerate the local CodeMirror bundle.

## Flight Mode Verification

1. Turn Airplane mode ON.
2. Cold boot the app.
3. Confirm the editor opens and syntax highlighting renders.
4. Open a file from `workspace`, edit it, and save it.
5. Restart app and verify the saved content persists.
6. Confirm Space Grotesk (UI) and JetBrains Mono (editor) render without fallback.

## GitHub Actions: Debug APK

Workflow file: `.github/workflows/debug-apk.yml`

- Installs dependencies
- Builds local CodeMirror bundle
- Runs Expo Android prebuild
- Executes `./gradlew assembleDebug`
- Uploads `app-debug.apk` as workflow artifact
