import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Alert,
  KeyboardAvoidingView,
  Modal,
  Platform,
  Pressable,
  ScrollView,
  StatusBar,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";
import AsyncStorage from "@react-native-async-storage/async-storage";
import { Asset } from "expo-asset";
import { useFonts } from "expo-font";
import * as FileSystem from "expo-file-system/legacy";
import {
  JetBrainsMono_400Regular,
  JetBrainsMono_500Medium,
} from "@expo-google-fonts/jetbrains-mono";
import {
  SpaceGrotesk_400Regular,
  SpaceGrotesk_700Bold,
} from "@expo-google-fonts/space-grotesk";
import { WebView } from "react-native-webview";
import { SafeAreaProvider, useSafeAreaInsets } from "react-native-safe-area-context";

type ScreenName = "home" | "editor" | "settings";
type EditorTheme = "one-dark" | "dracula" | "github-light";
type EditorLanguage =
  | "javascript"
  | "typescript"
  | "python"
  | "html"
  | "css"
  | "json"
  | "markdown"
  | "sql"
  | "bash"
  | "c"
  | "cpp"
  | "java"
  | "php"
  | "rust"
  | "go"
  | "text";

type ToolbarCommand =
  | "undo"
  | "redo"
  | "search"
  | "closeSearch"
  | "indent"
  | "comment"
  | "findNext"
  | "findPrevious";

interface AppSettings {
  theme: EditorTheme;
  wordWrap: boolean;
  tabSize: number;
  fontSize: number;
  lineNumbers: boolean;
  showHiddenFiles: boolean;
}

interface FileEntry {
  path: string;
  name: string;
  isDirectory: boolean;
  modifiedAt: number;
}

interface RecentFile {
  path: string;
  name: string;
  lastOpenedAt: number;
}

interface EditorTab {
  id: string;
  path: string;
  name: string;
  language: EditorLanguage;
  content: string;
  savedContent: string;
  line: number;
  col: number;
}

interface SearchState {
  query: string;
  replace: string;
  caseSensitive: boolean;
  regex: boolean;
  wholeWord: boolean;
}

interface PersistedSessionTab {
  id: string;
  path: string;
  name: string;
  language: EditorLanguage;
  content: string;
  savedContent: string;
  line: number;
  col: number;
}

interface PersistedSession {
  tabs: PersistedSessionTab[];
  activeTabId: string | null;
  currentDirectory: string;
  timestamp: number;
}

interface CommandHistoryEntry {
  id: string;
  label: string;
  timestamp: number;
}

interface WorkspaceSearchResult {
  path: string;
  line: number;
  col: number;
  snippet: string;
}

interface TrackerCommit {
  id: string;
  message: string;
  timestamp: number;
  files: string[];
}

interface TrackerState {
  initialized: boolean;
  trackedPaths: Record<string, string>;
  stagedPaths: string[];
  commits: TrackerCommit[];
}

interface TerminalLogEntry {
  id: string;
  type: "input" | "output" | "error";
  text: string;
}

interface PluginCommand {
  id: string;
  label: string;
  type: "insertText" | "openFile" | "showMessage";
  payload: string;
}

interface LocalPlugin {
  id: string;
  name: string;
  commands: PluginCommand[];
}

const STORAGE_SETTINGS_KEY = "ipcoder.settings.v1";
const STORAGE_RECENTS_KEY = "ipcoder.recents.v1";
const STORAGE_SESSION_KEY = "ipcoder.session.v1";
const STORAGE_COMMAND_HISTORY_KEY = "ipcoder.command-history.v1";
const STORAGE_TRACKER_KEY = "ipcoder.tracker.v1";
const STORAGE_PINNED_FOLDERS_KEY = "ipcoder.pinned-folders.v1";
const STORAGE_PROTECTED_PATHS_KEY = "ipcoder.protected-paths.v1";

const DOCUMENT_ROOT =
  FileSystem.documentDirectory ?? FileSystem.cacheDirectory ?? "file:///tmp";
const WORKSPACE_ROOT = `${DOCUMENT_ROOT.replace(/\/$/, "")}/workspace`;

const MAX_RECENT_FILES = 20;
const MAX_TABS = 8;
const MAX_COMMAND_HISTORY = 30;
const MAX_SEARCH_RESULTS = 200;
const MAX_TERMINAL_LINES = 250;

const THEME_ORDER: EditorTheme[] = ["one-dark", "dracula", "github-light"];

const DEFAULT_SETTINGS: AppSettings = {
  theme: "one-dark",
  wordWrap: true,
  tabSize: 2,
  fontSize: 13,
  lineNumbers: true,
  showHiddenFiles: false,
};

const DEFAULT_SEARCH_STATE: SearchState = {
  query: "",
  replace: "",
  caseSensitive: false,
  regex: false,
  wholeWord: false,
};

const BUILTIN_SNIPPETS: Array<{ id: string; label: string; body: string }> = [
  {
    id: "js-function",
    label: "JavaScript Function",
    body: "\nfunction name(params) {\n  return;\n}\n",
  },
  {
    id: "ts-interface",
    label: "TypeScript Interface",
    body: "\ninterface Name {\n  id: string;\n}\n",
  },
  {
    id: "py-main",
    label: "Python Main Guard",
    body: "\nif __name__ == \"__main__\":\n    main()\n",
  },
  {
    id: "react-component",
    label: "React Component",
    body: "\nexport function ComponentName() {\n  return <div />;\n}\n",
  },
  {
    id: "bash-script",
    label: "Bash Script Header",
    body: "\n#!/usr/bin/env bash\nset -euo pipefail\n\n",
  },
];

const stripTrailingSlash = (value: string) => value.replace(/\/+$/, "");

const joinFsPath = (base: string, name: string) =>
  `${stripTrailingSlash(base)}/${name}`;

const basename = (path: string) => {
  const cleaned = stripTrailingSlash(path);
  const index = cleaned.lastIndexOf("/");
  return index >= 0 ? cleaned.slice(index + 1) : cleaned;
};

const parentPath = (path: string, root: string) => {
  const cleanPath = stripTrailingSlash(path);
  const cleanRoot = stripTrailingSlash(root);

  if (cleanPath === cleanRoot) {
    return cleanRoot;
  }

  const index = cleanPath.lastIndexOf("/");
  if (index <= 0) {
    return cleanRoot;
  }

  return cleanPath.slice(0, index);
};

const isInsideRoot = (path: string, root: string) => {
  const cleanPath = stripTrailingSlash(path);
  const cleanRoot = stripTrailingSlash(root);
  return cleanPath === cleanRoot || cleanPath.startsWith(`${cleanRoot}/`);
};

const detectLanguage = (fileName: string): EditorLanguage => {
  const parts = fileName.split(".");
  const extension = parts.length > 1 ? parts.pop()?.toLowerCase() ?? "" : "";

  switch (extension) {
    case "js":
    case "jsx":
    case "mjs":
    case "cjs":
      return "javascript";
    case "ts":
    case "tsx":
      return "typescript";
    case "py":
      return "python";
    case "html":
    case "htm":
      return "html";
    case "css":
    case "scss":
      return "css";
    case "json":
      return "json";
    case "md":
    case "markdown":
      return "markdown";
    case "sql":
      return "sql";
    case "sh":
    case "bash":
      return "bash";
    case "c":
    case "h":
      return "c";
    case "cpp":
    case "cc":
    case "cxx":
    case "hpp":
      return "cpp";
    case "java":
      return "java";
    case "php":
      return "php";
    case "rs":
      return "rust";
    case "go":
      return "go";
    default:
      return "text";
  }
};

const webviewHtml = (bundleCode: string, jetbrainsBase64: string) => {
  const safeBundle = bundleCode.replace(/<\/script/gi, "<\\/script");

  return `<!doctype html>
<html>
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <style>
      @font-face {
        font-family: "JetBrainsMonoLocal";
        src: url("data:font/ttf;base64,${jetbrainsBase64}") format("truetype");
        font-weight: 400;
        font-style: normal;
      }
      html,
      body,
      #editor {
        margin: 0;
        padding: 0;
        width: 100%;
        height: 100%;
        background: #000000;
        color: #ffffff;
      }
      body {
        overflow: hidden;
        border: 0;
      }
    </style>
  </head>
  <body>
    <div id="editor"></div>
    <script>${safeBundle}</script>
  </body>
</html>`;
};

const formatRelativePath = (path: string) => {
  const cleanRoot = stripTrailingSlash(WORKSPACE_ROOT);
  const cleanPath = stripTrailingSlash(path);
  if (cleanPath === cleanRoot) {
    return "workspace";
  }

  return `workspace/${cleanPath.replace(`${cleanRoot}/`, "")}`;
};

const pathIsWithin = (value: string, prefix: string) => {
  const cleanValue = stripTrailingSlash(value);
  const cleanPrefix = stripTrailingSlash(prefix);
  return cleanValue === cleanPrefix || cleanValue.startsWith(`${cleanPrefix}/`);
};

const remapPathPrefix = (value: string, from: string, to: string) => {
  const cleanValue = stripTrailingSlash(value);
  const cleanFrom = stripTrailingSlash(from);
  const cleanTo = stripTrailingSlash(to);

  if (cleanValue === cleanFrom) {
    return cleanTo;
  }

  if (cleanValue.startsWith(`${cleanFrom}/`)) {
    return `${cleanTo}${cleanValue.slice(cleanFrom.length)}`;
  }

  return value;
};

const dedupeRecentsByPath = (items: RecentFile[]) => {
  const seen = new Set<string>();
  const next: RecentFile[] = [];

  for (const item of items) {
    if (seen.has(item.path)) {
      continue;
    }
    seen.add(item.path);
    next.push(item);
  }

  return next.slice(0, MAX_RECENT_FILES);
};

const isValidLanguage = (value: unknown): value is EditorLanguage => {
  if (typeof value !== "string") {
    return false;
  }
  const allowed: EditorLanguage[] = [
    "javascript",
    "typescript",
    "python",
    "html",
    "css",
    "json",
    "markdown",
    "sql",
    "bash",
    "c",
    "cpp",
    "java",
    "php",
    "rust",
    "go",
    "text",
  ];
  return allowed.includes(value as EditorLanguage);
};

const coercePersistedTab = (value: unknown): PersistedSessionTab | null => {
  if (!value || typeof value !== "object") {
    return null;
  }

  const candidate = value as Partial<PersistedSessionTab>;
  if (
    typeof candidate.id !== "string" ||
    typeof candidate.path !== "string" ||
    typeof candidate.name !== "string" ||
    !isValidLanguage(candidate.language) ||
    typeof candidate.content !== "string" ||
    typeof candidate.savedContent !== "string"
  ) {
    return null;
  }

  return {
    id: candidate.id,
    path: candidate.path,
    name: candidate.name,
    language: candidate.language,
    content: candidate.content,
    savedContent: candidate.savedContent,
    line: typeof candidate.line === "number" && candidate.line > 0 ? candidate.line : 1,
    col: typeof candidate.col === "number" && candidate.col > 0 ? candidate.col : 1,
  };
};

const textFileExtensions = new Set([
  "js",
  "jsx",
  "mjs",
  "cjs",
  "ts",
  "tsx",
  "py",
  "html",
  "htm",
  "css",
  "scss",
  "json",
  "md",
  "markdown",
  "sql",
  "sh",
  "bash",
  "c",
  "h",
  "cpp",
  "cc",
  "cxx",
  "hpp",
  "java",
  "php",
  "rs",
  "go",
  "txt",
  "yaml",
  "yml",
  "xml",
]);

const isTextFilePath = (path: string) => {
  const name = basename(path);
  const dot = name.lastIndexOf(".");
  if (dot <= 0) {
    return true;
  }
  return textFileExtensions.has(name.slice(dot + 1).toLowerCase());
};

const quickHash = (value: string) => {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash +=
      (hash << 1) + (hash << 4) + (hash << 7) + (hash << 8) + (hash << 24);
  }
  return `h${(hash >>> 0).toString(16)}`;
};

function IPCoderApp() {
  const webviewRef = useRef<WebView>(null);
  const syncedTabForWebViewRef = useRef<string | null>(null);
  const insets = useSafeAreaInsets();

  const [fontsLoaded] = useFonts({
    SpaceGrotesk_400Regular,
    SpaceGrotesk_700Bold,
    JetBrainsMono_400Regular,
    JetBrainsMono_500Medium,
  });

  const [screen, setScreen] = useState<ScreenName>("home");
  const [settings, setSettings] = useState<AppSettings>(DEFAULT_SETTINGS);
  const [currentDirectory, setCurrentDirectory] = useState<string>(WORKSPACE_ROOT);
  const [entries, setEntries] = useState<FileEntry[]>([]);
  const [recents, setRecents] = useState<RecentFile[]>([]);
  const [tabs, setTabs] = useState<EditorTab[]>([]);
  const [activeTabId, setActiveTabId] = useState<string | null>(null);
  const [searchVisible, setSearchVisible] = useState<boolean>(false);
  const [searchState, setSearchState] = useState<SearchState>(DEFAULT_SEARCH_STATE);
  const [bundleCode, setBundleCode] = useState<string | null>(null);
  const [jetbrainsFontBase64, setJetbrainsFontBase64] = useState<string | null>(null);
  const [editorReady, setEditorReady] = useState<boolean>(false);
  const [loadingState, setLoadingState] = useState<string>("Booting workspace...");
  const [newFileModalVisible, setNewFileModalVisible] = useState<boolean>(false);
  const [newFileName, setNewFileName] = useState<string>("untitled.js");
  const [newFolderModalVisible, setNewFolderModalVisible] = useState<boolean>(false);
  const [newFolderName, setNewFolderName] = useState<string>("new-folder");
  const [entryActionModalVisible, setEntryActionModalVisible] = useState<boolean>(false);
  const [selectedEntry, setSelectedEntry] = useState<FileEntry | null>(null);
  const [renameModalVisible, setRenameModalVisible] = useState<boolean>(false);
  const [renameValue, setRenameValue] = useState<string>("");
  const [sessionHydrated, setSessionHydrated] = useState<boolean>(false);
  const [commandPaletteVisible, setCommandPaletteVisible] = useState<boolean>(false);
  const [commandQuery, setCommandQuery] = useState<string>("");
  const [goToLineValue, setGoToLineValue] = useState<string>("");
  const [commandHistory, setCommandHistory] = useState<CommandHistoryEntry[]>([]);
  const [workspaceSearchVisible, setWorkspaceSearchVisible] = useState<boolean>(false);
  const [workspaceSearchQuery, setWorkspaceSearchQuery] = useState<string>("");
  const [workspaceReplaceValue, setWorkspaceReplaceValue] = useState<string>("");
  const [workspaceSearchResults, setWorkspaceSearchResults] = useState<WorkspaceSearchResult[]>([]);
  const [workspaceSearchBusy, setWorkspaceSearchBusy] = useState<boolean>(false);
  const [trackerState, setTrackerState] = useState<TrackerState>({
    initialized: false,
    trackedPaths: {},
    stagedPaths: [],
    commits: [],
  });
  const [trackerVisible, setTrackerVisible] = useState<boolean>(false);
  const [trackerCommitMessage, setTrackerCommitMessage] = useState<string>("");
  const [terminalVisible, setTerminalVisible] = useState<boolean>(false);
  const [terminalInput, setTerminalInput] = useState<string>("");
  const [terminalLogs, setTerminalLogs] = useState<TerminalLogEntry[]>([]);
  const [snippetVisible, setSnippetVisible] = useState<boolean>(false);
  const [selectionMode, setSelectionMode] = useState<boolean>(false);
  const [selectedPaths, setSelectedPaths] = useState<string[]>([]);
  const [pinnedFolders, setPinnedFolders] = useState<string[]>([]);
  const [showMiniMap, setShowMiniMap] = useState<boolean>(false);
  const [outlineVisible, setOutlineVisible] = useState<boolean>(false);
  const [readOnlyMode, setReadOnlyMode] = useState<boolean>(false);
  const [protectedPaths, setProtectedPaths] = useState<string[]>([]);
  const [plugins, setPlugins] = useState<LocalPlugin[]>([]);

  const activeTab = useMemo(
    () => tabs.find((tab) => tab.id === activeTabId) ?? null,
    [tabs, activeTabId],
  );
  const unsavedPathSet = useMemo(
    () => new Set(tabs.filter((tab) => tab.content !== tab.savedContent).map((tab) => tab.path)),
    [tabs],
  );

  const editorHtml = useMemo(() => {
    if (!bundleCode || !jetbrainsFontBase64) {
      return null;
    }

    return webviewHtml(bundleCode, jetbrainsFontBase64);
  }, [bundleCode, jetbrainsFontBase64]);

  const persistSettings = useCallback(async (next: AppSettings) => {
    setSettings(next);
    await AsyncStorage.setItem(STORAGE_SETTINGS_KEY, JSON.stringify(next));
  }, []);

  const persistRecents = useCallback(async (next: RecentFile[]) => {
    setRecents(next);
    await AsyncStorage.setItem(STORAGE_RECENTS_KEY, JSON.stringify(next));
  }, []);

  const persistCommandHistory = useCallback(async (next: CommandHistoryEntry[]) => {
    setCommandHistory(next);
    await AsyncStorage.setItem(STORAGE_COMMAND_HISTORY_KEY, JSON.stringify(next));
  }, []);

  const persistTrackerState = useCallback(async (next: TrackerState) => {
    setTrackerState(next);
    await AsyncStorage.setItem(STORAGE_TRACKER_KEY, JSON.stringify(next));
  }, []);

  const persistPinnedFolders = useCallback(async (next: string[]) => {
    const deduped = Array.from(new Set(next.filter((item) => pathIsWithin(item, WORKSPACE_ROOT))));
    setPinnedFolders(deduped);
    await AsyncStorage.setItem(STORAGE_PINNED_FOLDERS_KEY, JSON.stringify(deduped));
  }, []);

  const persistProtectedPaths = useCallback(async (next: string[]) => {
    const deduped = Array.from(new Set(next.filter((item) => pathIsWithin(item, WORKSPACE_ROOT))));
    setProtectedPaths(deduped);
    await AsyncStorage.setItem(STORAGE_PROTECTED_PATHS_KEY, JSON.stringify(deduped));
  }, []);

  const addCommandHistory = useCallback(
    async (label: string) => {
      const next = [
        {
          id: `${Date.now()}-${Math.random().toString(16).slice(2)}`,
          label,
          timestamp: Date.now(),
        },
        ...commandHistory.filter((entry) => entry.label !== label),
      ].slice(0, MAX_COMMAND_HISTORY);
      await persistCommandHistory(next);
    },
    [commandHistory, persistCommandHistory],
  );

  const appendTerminalLog = useCallback((type: TerminalLogEntry["type"], text: string) => {
    setTerminalLogs((prev) => {
      const next = [
        ...prev,
        {
          id: `${Date.now()}-${Math.random().toString(16).slice(2)}`,
          type,
          text,
        },
      ];
      return next.slice(-MAX_TERMINAL_LINES);
    });
  }, []);

  const sendToEditor = useCallback((payload: Record<string, unknown>) => {
    if (!webviewRef.current) {
      return;
    }

    webviewRef.current.postMessage(JSON.stringify(payload));
  }, []);

  const isProtectedPath = useCallback(
    (path: string) => protectedPaths.some((item) => pathIsWithin(path, item)),
    [protectedPaths],
  );

  const listWorkspaceFiles = useCallback(
    async (startPath = WORKSPACE_ROOT) => {
      const stack = [startPath];
      const results: FileEntry[] = [];

      while (stack.length) {
        const current = stack.pop();
        if (!current) {
          continue;
        }

        let names: string[] = [];
        try {
          names = await FileSystem.readDirectoryAsync(current);
        } catch {
          continue;
        }

        for (const name of names) {
          if (!settings.showHiddenFiles && name.startsWith(".")) {
            continue;
          }
          const path = joinFsPath(current, name);
          const info = await FileSystem.getInfoAsync(path);
          if (!info.exists) {
            continue;
          }
          const isDirectory = info.isDirectory ?? false;
          const modifiedAt =
            "modificationTime" in info && typeof info.modificationTime === "number"
              ? info.modificationTime * 1000
              : 0;

          results.push({
            path,
            name,
            isDirectory,
            modifiedAt,
          });

          if (isDirectory) {
            stack.push(path);
          }
        }
      }

      return results;
    },
    [settings.showHiddenFiles],
  );

  const readFileAsTextSafe = useCallback(async (path: string) => {
    try {
      if (!isTextFilePath(path)) {
        return null;
      }
      const content = await FileSystem.readAsStringAsync(path, {
        encoding: FileSystem.EncodingType.UTF8,
      });
      return content;
    } catch {
      return null;
    }
  }, []);

  const syncActiveTabToEditor = useCallback(
    (tab: EditorTab) => {
      syncedTabForWebViewRef.current = null;
      sendToEditor({
        type: "setDoc",
        payload: {
          doc: tab.content,
          language: tab.language,
        },
      });
      sendToEditor({ type: "requestState" });
    },
    [sendToEditor],
  );

  const setCurrentTabContent = useCallback(
    (nextContent: string) => {
      if (!activeTabId) {
        return;
      }

      setTabs((prev) =>
        prev.map((tab) =>
          tab.id === activeTabId
            ? {
                ...tab,
                content: nextContent,
              }
            : tab,
        ),
      );
    },
    [activeTabId],
  );

  const touchRecentFile = useCallback(
    async (path: string) => {
      const name = basename(path);
      const nextEntry: RecentFile = {
        path,
        name,
        lastOpenedAt: Date.now(),
      };

      const deduped = recents.filter((item) => item.path !== path);
      const next = [nextEntry, ...deduped].slice(0, MAX_RECENT_FILES);
      await persistRecents(next);
    },
    [persistRecents, recents],
  );

  const removeRecentEntriesByPrefix = useCallback(
    async (prefixPath: string) => {
      const next = recents.filter((item) => !pathIsWithin(item.path, prefixPath));
      await persistRecents(next);
    },
    [persistRecents, recents],
  );

  const remapRecentEntriesByPrefix = useCallback(
    async (fromPath: string, toPath: string) => {
      const mapped = recents.map((item) => {
        const nextPath = remapPathPrefix(item.path, fromPath, toPath);
        return {
          ...item,
          path: nextPath,
          name: basename(nextPath),
        };
      });

      await persistRecents(dedupeRecentsByPath(mapped));
    },
    [persistRecents, recents],
  );

  const openEntryActionMenu = useCallback((entry: FileEntry) => {
    setSelectedEntry(entry);
    setEntryActionModalVisible(true);
  }, []);

  const refreshCurrentDirectory = useCallback(async () => {
    setLoadingState("Reading local files...");

    try {
      let children: string[] = [];

      try {
        children = await FileSystem.readDirectoryAsync(currentDirectory);
      } catch {
        await FileSystem.makeDirectoryAsync(currentDirectory, { intermediates: true });
        children = await FileSystem.readDirectoryAsync(currentDirectory);
      }

      const mapped = await Promise.all(
        children.map(async (name) => {
          const path = joinFsPath(currentDirectory, name);
          const info = await FileSystem.getInfoAsync(path);
          const modifiedAt =
            info.exists &&
            "modificationTime" in info &&
            typeof info.modificationTime === "number"
              ? info.modificationTime * 1000
              : 0;

          return {
            path,
            name,
            isDirectory: info.isDirectory ?? false,
            modifiedAt,
          } satisfies FileEntry;
        }),
      );

      const visible = settings.showHiddenFiles
        ? mapped
        : mapped.filter((entry) => !entry.name.startsWith("."));

      visible.sort((left, right) => {
        if (left.isDirectory !== right.isDirectory) {
          return left.isDirectory ? -1 : 1;
        }
        return left.name.localeCompare(right.name);
      });

      setEntries(visible);
    } catch (error) {
      console.error(error);
      setEntries([]);
    } finally {
      setLoadingState("");
    }
  }, [currentDirectory, settings.showHiddenFiles]);

  const createWorkspaceIfMissing = useCallback(async () => {
    await FileSystem.makeDirectoryAsync(WORKSPACE_ROOT, { intermediates: true });

    const welcomeFile = joinFsPath(WORKSPACE_ROOT, "README.md");
    const welcomeInfo = await FileSystem.getInfoAsync(welcomeFile);

    if (!welcomeInfo.exists) {
      await FileSystem.writeAsStringAsync(
        welcomeFile,
        "# IPCoder\n\nOffline code editor workspace.\n",
        { encoding: FileSystem.EncodingType.UTF8 },
      );
    }
  }, []);

  const loadOfflineEditorAssets = useCallback(async () => {
    setLoadingState("Loading bundled editor assets...");

    const bundleAsset = Asset.fromModule(require("./assets/editor/codemirror.bundle.txt"));
    await bundleAsset.downloadAsync();

    const bundleUri = bundleAsset.localUri ?? bundleAsset.uri;
    const bundleText = await FileSystem.readAsStringAsync(bundleUri);

    const jetbrainsAsset = Asset.fromModule(JetBrainsMono_400Regular);
    await jetbrainsAsset.downloadAsync();

    const fontUri = jetbrainsAsset.localUri ?? jetbrainsAsset.uri;
    const fontBase64 = await FileSystem.readAsStringAsync(fontUri, {
      encoding: FileSystem.EncodingType.Base64,
    });

    setBundleCode(bundleText);
    setJetbrainsFontBase64(fontBase64);
  }, []);

  const loadLocalPlugins = useCallback(async () => {
    const pluginsRoot = joinFsPath(WORKSPACE_ROOT, ".ipcoder/plugins");
    await FileSystem.makeDirectoryAsync(pluginsRoot, { intermediates: true });

    const files = await FileSystem.readDirectoryAsync(pluginsRoot);
    const nextPlugins: LocalPlugin[] = [];

    for (const name of files) {
      if (!name.toLowerCase().endsWith(".json")) {
        continue;
      }

      const path = joinFsPath(pluginsRoot, name);
      const content = await readFileAsTextSafe(path);
      if (!content) {
        continue;
      }

      try {
        const parsed = JSON.parse(content) as Partial<LocalPlugin>;
        if (
          typeof parsed.id !== "string" ||
          typeof parsed.name !== "string" ||
          !Array.isArray(parsed.commands)
        ) {
          continue;
        }

        const commands = parsed.commands.filter(
          (cmd): cmd is PluginCommand =>
            !!cmd &&
            typeof cmd.id === "string" &&
            typeof cmd.label === "string" &&
            (cmd.type === "insertText" ||
              cmd.type === "openFile" ||
              cmd.type === "showMessage") &&
            typeof cmd.payload === "string",
        );

        nextPlugins.push({
          id: parsed.id,
          name: parsed.name,
          commands,
        });
      } catch {
        continue;
      }
    }

    setPlugins(nextPlugins);
  }, [readFileAsTextSafe]);

  useEffect(() => {
    let cancelled = false;

    const bootstrap = async () => {
      try {
        const [
          savedSettingsRaw,
          savedRecentsRaw,
          savedSessionRaw,
          savedCommandHistoryRaw,
          savedTrackerRaw,
          savedPinnedRaw,
          savedProtectedRaw,
        ] = await Promise.all([
          AsyncStorage.getItem(STORAGE_SETTINGS_KEY),
          AsyncStorage.getItem(STORAGE_RECENTS_KEY),
          AsyncStorage.getItem(STORAGE_SESSION_KEY),
          AsyncStorage.getItem(STORAGE_COMMAND_HISTORY_KEY),
          AsyncStorage.getItem(STORAGE_TRACKER_KEY),
          AsyncStorage.getItem(STORAGE_PINNED_FOLDERS_KEY),
          AsyncStorage.getItem(STORAGE_PROTECTED_PATHS_KEY),
        ]);

        if (savedSettingsRaw) {
          const parsed = JSON.parse(savedSettingsRaw) as Partial<AppSettings>;
          if (!cancelled) {
            setSettings({ ...DEFAULT_SETTINGS, ...parsed });
          }
        }

        if (savedRecentsRaw) {
          const parsed = JSON.parse(savedRecentsRaw) as RecentFile[];
          if (!cancelled) {
            setRecents(parsed.slice(0, MAX_RECENT_FILES));
          }
        }

        if (savedCommandHistoryRaw) {
          const parsed = JSON.parse(savedCommandHistoryRaw) as CommandHistoryEntry[];
          if (!cancelled && Array.isArray(parsed)) {
            setCommandHistory(parsed.slice(0, MAX_COMMAND_HISTORY));
          }
        }

        if (savedTrackerRaw) {
          const parsed = JSON.parse(savedTrackerRaw) as Partial<TrackerState>;
          if (!cancelled && parsed && typeof parsed === "object") {
            setTrackerState({
              initialized: !!parsed.initialized,
              trackedPaths:
                parsed.trackedPaths &&
                typeof parsed.trackedPaths === "object" &&
                !Array.isArray(parsed.trackedPaths)
                  ? Object.fromEntries(
                      Object.entries(parsed.trackedPaths).filter(
                        (entry): entry is [string, string] =>
                          typeof entry[0] === "string" && typeof entry[1] === "string",
                      ),
                    )
                  : {},
              stagedPaths: Array.isArray(parsed.stagedPaths)
                ? parsed.stagedPaths.filter((path): path is string => typeof path === "string")
                : [],
              commits: Array.isArray(parsed.commits)
                ? parsed.commits.filter(
                    (commit): commit is TrackerCommit =>
                      !!commit &&
                      typeof commit.id === "string" &&
                      typeof commit.message === "string" &&
                      typeof commit.timestamp === "number" &&
                      Array.isArray(commit.files),
                  )
                : [],
            });
          }
        }

        if (savedPinnedRaw) {
          const parsed = JSON.parse(savedPinnedRaw) as string[];
          if (!cancelled && Array.isArray(parsed)) {
            setPinnedFolders(
              parsed.filter(
                (item): item is string =>
                  typeof item === "string" && pathIsWithin(item, WORKSPACE_ROOT),
              ),
            );
          }
        }

        if (savedProtectedRaw) {
          const parsed = JSON.parse(savedProtectedRaw) as string[];
          if (!cancelled && Array.isArray(parsed)) {
            setProtectedPaths(
              parsed.filter(
                (item): item is string =>
                  typeof item === "string" && pathIsWithin(item, WORKSPACE_ROOT),
              ),
            );
          }
        }

        await createWorkspaceIfMissing();
        await loadLocalPlugins();

        if (savedSessionRaw) {
          const parsed = JSON.parse(savedSessionRaw) as Partial<PersistedSession>;
          const sessionTabs = Array.isArray(parsed.tabs)
            ? parsed.tabs
                .map(coercePersistedTab)
                .filter((item): item is PersistedSessionTab => item !== null)
                .filter((item) => pathIsWithin(item.path, WORKSPACE_ROOT))
                .slice(0, MAX_TABS)
            : [];

          if (!cancelled) {
            if (sessionTabs.length) {
              setTabs(sessionTabs);
              const preferredActive =
                typeof parsed.activeTabId === "string"
                  ? sessionTabs.find((tab) => tab.id === parsed.activeTabId)?.id ?? null
                  : null;
              setActiveTabId(preferredActive ?? sessionTabs[0].id);
            }

            if (
              typeof parsed.currentDirectory === "string" &&
              pathIsWithin(parsed.currentDirectory, WORKSPACE_ROOT)
            ) {
              setCurrentDirectory(parsed.currentDirectory);
            }
          }
        }

        await loadOfflineEditorAssets();
        if (!cancelled) {
          setLoadingState("");
          setSessionHydrated(true);
        }
      } catch (error) {
        console.error(error);
        Alert.alert(
          "Bootstrap Error",
          "Failed to initialize offline editor assets. Verify local bundle generation.",
        );
      } finally {
        if (!cancelled) {
          setSessionHydrated(true);
        }
      }
    };

    void bootstrap();

    return () => {
      cancelled = true;
    };
  }, [createWorkspaceIfMissing, loadLocalPlugins, loadOfflineEditorAssets]);

  useEffect(() => {
    void refreshCurrentDirectory();
  }, [refreshCurrentDirectory]);

  useEffect(() => {
    if (!selectionMode && selectedPaths.length) {
      setSelectedPaths([]);
    }
  }, [selectedPaths.length, selectionMode]);

  useEffect(() => {
    if (!sessionHydrated) {
      return;
    }

    const timeout = setTimeout(() => {
      const payload: PersistedSession = {
        tabs: tabs.map((tab) => ({
          id: tab.id,
          path: tab.path,
          name: tab.name,
          language: tab.language,
          content: tab.content,
          savedContent: tab.savedContent,
          line: tab.line,
          col: tab.col,
        })),
        activeTabId,
        currentDirectory,
        timestamp: Date.now(),
      };

      void AsyncStorage.setItem(STORAGE_SESSION_KEY, JSON.stringify(payload));
    }, 300);

    return () => {
      clearTimeout(timeout);
    };
  }, [activeTabId, currentDirectory, sessionHydrated, tabs]);

  useEffect(() => {
    if (!editorReady) {
      return;
    }

    sendToEditor({
      type: "setTheme",
      payload: { theme: settings.theme },
    });

    sendToEditor({
      type: "setWordWrap",
      payload: { enabled: settings.wordWrap },
    });

    sendToEditor({
      type: "setTabSize",
      payload: { size: settings.tabSize },
    });

    sendToEditor({
      type: "setFontSize",
      payload: { size: settings.fontSize },
    });

    sendToEditor({
      type: "setLineNumbers",
      payload: { enabled: settings.lineNumbers },
    });
  }, [editorReady, sendToEditor, settings]);

  useEffect(() => {
    if (!editorReady || !activeTab) {
      return;
    }

    if (syncedTabForWebViewRef.current === activeTab.id) {
      return;
    }

    syncedTabForWebViewRef.current = activeTab.id;

    sendToEditor({
      type: "setDoc",
      payload: {
        doc: activeTab.content,
        language: activeTab.language,
      },
    });

    sendToEditor({ type: "requestState" });
  }, [activeTab, editorReady, sendToEditor]);

  useEffect(() => {
    if (!editorReady) {
      return;
    }

    if (!searchVisible) {
      sendToEditor({
        type: "search",
        payload: {
          query: "",
          replace: "",
          caseSensitive: false,
          regex: false,
          wholeWord: false,
        },
      });
      return;
    }

    sendToEditor({
      type: "search",
      payload: {
        query: searchState.query,
        replace: searchState.replace,
        caseSensitive: searchState.caseSensitive,
        regex: searchState.regex,
        wholeWord: searchState.wholeWord,
      },
    });
  }, [editorReady, searchVisible, searchState, sendToEditor]);

  const openFile = useCallback(
    async (path: string) => {
      try {
        const fileInfo = await FileSystem.getInfoAsync(path);
        if (!fileInfo.exists || fileInfo.isDirectory) {
          return;
        }

        const existingTab = tabs.find((tab) => tab.path === path);
        if (existingTab) {
          setActiveTabId(existingTab.id);
          setScreen("editor");
          await touchRecentFile(path);
          return;
        }

        const content = await FileSystem.readAsStringAsync(path, {
          encoding: FileSystem.EncodingType.UTF8,
        });

        let nextTabs = [...tabs];

        if (nextTabs.length >= MAX_TABS) {
          const removableIndex = nextTabs.findIndex(
            (tab) => tab.id !== activeTabId && tab.content === tab.savedContent,
          );

          if (removableIndex === -1) {
            Alert.alert(
              "Tab Limit Reached",
              "Close or save an existing tab before opening more files.",
            );
            return;
          }

          nextTabs.splice(removableIndex, 1);
        }

        const tab: EditorTab = {
          id: `${Date.now()}-${Math.random().toString(16).slice(2)}`,
          path,
          name: basename(path),
          language: detectLanguage(path),
          content,
          savedContent: content,
          line: 1,
          col: 1,
        };

        nextTabs = [...nextTabs, tab];
        setTabs(nextTabs);
        setActiveTabId(tab.id);
        setScreen("editor");
        await touchRecentFile(path);
      } catch (error) {
        console.error(error);
        Alert.alert("Open Error", "Unable to open the selected file.");
      }
    },
    [activeTabId, tabs, touchRecentFile],
  );

  const backupFileIfNeeded = useCallback(async (path: string, content: string) => {
    try {
      const backupDir = joinFsPath(WORKSPACE_ROOT, ".ipcoder/backups");
      await FileSystem.makeDirectoryAsync(backupDir, { intermediates: true });
      const stamp = new Date().toISOString().replace(/[:.]/g, "-");
      const backupPath = joinFsPath(
        backupDir,
        `${basename(path)}.${stamp}.bak`,
      );
      await FileSystem.writeAsStringAsync(backupPath, content, {
        encoding: FileSystem.EncodingType.UTF8,
      });
    } catch {
      // Backup errors should not block editor operations.
    }
  }, []);

  const saveActiveTab = useCallback(async () => {
    if (!activeTab) {
      return;
    }
    if (readOnlyMode || isProtectedPath(activeTab.path)) {
      Alert.alert("Read Only", "Current file is protected or read-only.");
      return;
    }

    try {
      await backupFileIfNeeded(activeTab.path, activeTab.savedContent);
      await FileSystem.writeAsStringAsync(activeTab.path, activeTab.content, {
        encoding: FileSystem.EncodingType.UTF8,
      });

      setTabs((prev) =>
        prev.map((tab) =>
          tab.id === activeTab.id
            ? {
                ...tab,
                savedContent: tab.content,
              }
            : tab,
        ),
      );

      await touchRecentFile(activeTab.path);
      await refreshCurrentDirectory();
      await addCommandHistory(`Save ${activeTab.name}`);
    } catch (error) {
      console.error(error);
      Alert.alert("Save Error", "Unable to save the current file.");
    }
  }, [
    activeTab,
    addCommandHistory,
    backupFileIfNeeded,
    isProtectedPath,
    readOnlyMode,
    refreshCurrentDirectory,
    touchRecentFile,
  ]);

  const closeTab = useCallback(
    (tabId: string) => {
      const target = tabs.find((tab) => tab.id === tabId);
      if (!target) {
        return;
      }

      const closeNow = () => {
        const index = tabs.findIndex((tab) => tab.id === tabId);
        const nextTabs = tabs.filter((tab) => tab.id !== tabId);

        setTabs(nextTabs);

        if (!nextTabs.length) {
          setActiveTabId(null);
          setSearchVisible(false);
          return;
        }

        if (activeTabId === tabId) {
          const fallback = nextTabs[Math.max(0, index - 1)] ?? nextTabs[0];
          setActiveTabId(fallback.id);
        }
      };

      if (target.content !== target.savedContent) {
        Alert.alert("Unsaved Changes", `Close ${target.name} without saving?`, [
          { text: "Cancel", style: "cancel" },
          { text: "Close", style: "destructive", onPress: closeNow },
        ]);
        return;
      }

      closeNow();
    },
    [activeTabId, tabs],
  );

  const createFile = useCallback(async () => {
    const trimmed = newFileName.trim();
    if (!trimmed) {
      Alert.alert("Invalid Name", "Enter a file name.");
      return;
    }
    if (trimmed.includes("/") || trimmed.includes("\\")) {
      Alert.alert("Invalid Name", "File names cannot include / or \\.");
      return;
    }

    const destination = joinFsPath(currentDirectory, trimmed);
    if (readOnlyMode || isProtectedPath(destination)) {
      Alert.alert("Read Only", "Target path is protected or read-only.");
      return;
    }

    try {
      const fileInfo = await FileSystem.getInfoAsync(destination);
      if (fileInfo.exists) {
        Alert.alert("Already Exists", "A file with this name already exists.");
        return;
      }

      await FileSystem.writeAsStringAsync(destination, "", {
        encoding: FileSystem.EncodingType.UTF8,
      });

      setNewFileModalVisible(false);
      setNewFileName("untitled.js");

      await refreshCurrentDirectory();
      await openFile(destination);
      await addCommandHistory(`Create File ${trimmed}`);
    } catch (error) {
      console.error(error);
      Alert.alert("Create Error", "Unable to create the file.");
    }
  }, [
    addCommandHistory,
    currentDirectory,
    isProtectedPath,
    newFileName,
    openFile,
    readOnlyMode,
    refreshCurrentDirectory,
  ]);

  const applyActiveTabContent = useCallback(
    async (nextContent: string, actionLabel: string) => {
      if (!activeTab) {
        return;
      }
      if (readOnlyMode || isProtectedPath(activeTab.path)) {
        Alert.alert("Read Only", "Current file is protected or read-only.");
        return;
      }

      setTabs((prev) =>
        prev.map((tab) =>
          tab.id === activeTab.id
            ? {
                ...tab,
                content: nextContent,
              }
            : tab,
        ),
      );

      syncActiveTabToEditor({
        ...activeTab,
        content: nextContent,
      });
      await addCommandHistory(actionLabel);
    },
    [activeTab, addCommandHistory, isProtectedPath, readOnlyMode, syncActiveTabToEditor],
  );

  const formatActiveDocument = useCallback(async () => {
    if (!activeTab) {
      return;
    }

    const lines = activeTab.content.split("\n");
    const trimmed = lines.map((line) => line.replace(/\s+$/g, ""));
    const normalized = trimmed.join("\n").replace(/\t/g, " ".repeat(settings.tabSize));
    const withTrailing = normalized.endsWith("\n") ? normalized : `${normalized}\n`;

    await applyActiveTabContent(withTrailing, "Format Document");
  }, [activeTab, applyActiveTabContent, settings.tabSize]);

  const insertSnippetIntoActiveTab = useCallback(
    async (snippet: string) => {
      if (!activeTab) {
        return;
      }
      await applyActiveTabContent(`${activeTab.content}${snippet}`, "Insert Snippet");
      setSnippetVisible(false);
    },
    [activeTab, applyActiveTabContent],
  );

  const goToLine = useCallback(
    async (lineText: string) => {
      if (!activeTab) {
        return;
      }
      const line = Math.max(1, Number.parseInt(lineText, 10) || 1);
      sendToEditor({
        type: "setCursor",
        payload: {
          line,
          col: 1,
        },
      });
      setCommandPaletteVisible(false);
      setGoToLineValue("");
      await addCommandHistory(`Go To Line ${line}`);
    },
    [activeTab, addCommandHistory, sendToEditor],
  );

  const quickOpenMatches = useMemo(() => {
    const pool = new Map<string, { path: string; name: string }>();

    for (const entry of entries) {
      if (entry.isDirectory) {
        continue;
      }
      pool.set(entry.path, { path: entry.path, name: entry.name });
    }

    for (const item of recents) {
      if (!pathIsWithin(item.path, WORKSPACE_ROOT)) {
        continue;
      }
      pool.set(item.path, { path: item.path, name: item.name });
    }

    for (const tab of tabs) {
      pool.set(tab.path, { path: tab.path, name: tab.name });
    }

    const query = commandQuery.trim().toLowerCase();
    const sorted = Array.from(pool.values()).sort((left, right) =>
      left.name.localeCompare(right.name),
    );

    if (!query) {
      return sorted.slice(0, 30);
    }

    return sorted
      .filter(
        (item) =>
          item.name.toLowerCase().includes(query) ||
          formatRelativePath(item.path).toLowerCase().includes(query),
      )
      .slice(0, 30);
  }, [commandQuery, entries, recents, tabs]);

  const pluginCommandMatches = useMemo(() => {
    const query = commandQuery.trim().toLowerCase();
    const flattened = plugins.flatMap((plugin) =>
      plugin.commands.map((command) => ({
        pluginId: plugin.id,
        pluginName: plugin.name,
        command,
      })),
    );

    if (!query) {
      return flattened.slice(0, 20);
    }

    return flattened
      .filter(
        (item) =>
          item.command.label.toLowerCase().includes(query) ||
          item.pluginName.toLowerCase().includes(query),
      )
      .slice(0, 20);
  }, [commandQuery, plugins]);

  const pluginInsertCommands = useMemo(
    () =>
      plugins.flatMap((plugin) =>
        plugin.commands
          .filter((command) => command.type === "insertText")
          .map((command) => ({
            pluginId: plugin.id,
            pluginName: plugin.name,
            command,
          })),
      ),
    [plugins],
  );

  const runWorkspaceSearch = useCallback(async () => {
    const query = workspaceSearchQuery.trim();
    if (!query) {
      setWorkspaceSearchResults([]);
      return;
    }

    setWorkspaceSearchBusy(true);
    try {
      const files = await listWorkspaceFiles();
      const textFiles = files.filter((item) => !item.isDirectory && isTextFilePath(item.path));
      const results: WorkspaceSearchResult[] = [];

      for (const entry of textFiles) {
        const content = await readFileAsTextSafe(entry.path);
        if (!content) {
          continue;
        }
        const lines = content.split("\n");
        for (let lineIndex = 0; lineIndex < lines.length; lineIndex += 1) {
          const lineText = lines[lineIndex];
          const col = lineText.toLowerCase().indexOf(query.toLowerCase());
          if (col < 0) {
            continue;
          }
          results.push({
            path: entry.path,
            line: lineIndex + 1,
            col: col + 1,
            snippet: lineText.trim().slice(0, 180),
          });
          if (results.length >= MAX_SEARCH_RESULTS) {
            break;
          }
        }
        if (results.length >= MAX_SEARCH_RESULTS) {
          break;
        }
      }

      setWorkspaceSearchResults(results);
      await addCommandHistory(`Workspace Search: ${query}`);
    } finally {
      setWorkspaceSearchBusy(false);
    }
  }, [addCommandHistory, listWorkspaceFiles, readFileAsTextSafe, workspaceSearchQuery]);

  const openSearchResult = useCallback(
    async (result: WorkspaceSearchResult) => {
      await openFile(result.path);
      setScreen("editor");
      setWorkspaceSearchVisible(false);
      setTimeout(() => {
        sendToEditor({
          type: "setCursor",
          payload: { line: result.line, col: result.col },
        });
        sendToEditor({
          type: "search",
          payload: {
            query: workspaceSearchQuery,
            replace: "",
            caseSensitive: false,
            regex: false,
            wholeWord: false,
          },
        });
      }, 200);
    },
    [openFile, sendToEditor, workspaceSearchQuery],
  );

  const replaceAcrossSearchResults = useCallback(async () => {
    const searchFor = workspaceSearchQuery;
    if (!searchFor) {
      return;
    }
    if (readOnlyMode) {
      Alert.alert("Read Only", "Disable read-only mode to replace.");
      return;
    }

    const targetPaths = Array.from(new Set(workspaceSearchResults.map((item) => item.path)));
    for (const path of targetPaths) {
      if (isProtectedPath(path)) {
        continue;
      }
      const content = await readFileAsTextSafe(path);
      if (content === null) {
        continue;
      }
      if (!content.toLowerCase().includes(searchFor.toLowerCase())) {
        continue;
      }
      await backupFileIfNeeded(path, content);
      const escaped = searchFor.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      const replaced = content.replace(new RegExp(escaped, "gi"), workspaceReplaceValue);
      await FileSystem.writeAsStringAsync(path, replaced, {
        encoding: FileSystem.EncodingType.UTF8,
      });

      setTabs((prev) =>
        prev.map((tab) =>
          tab.path === path
            ? {
                ...tab,
                content: replaced,
                savedContent: replaced,
              }
            : tab,
        ),
      );
    }

    if (activeTab) {
      const refreshed = tabs.find((tab) => tab.id === activeTab.id);
      if (refreshed) {
        syncActiveTabToEditor(refreshed);
      }
    }

    await refreshCurrentDirectory();
    await runWorkspaceSearch();
    await addCommandHistory(`Replace In Search Results: ${searchFor}`);
  }, [
    activeTab,
    addCommandHistory,
    backupFileIfNeeded,
    isProtectedPath,
    readFileAsTextSafe,
    readOnlyMode,
    refreshCurrentDirectory,
    runWorkspaceSearch,
    syncActiveTabToEditor,
    tabs,
    workspaceReplaceValue,
    workspaceSearchQuery,
    workspaceSearchResults,
  ]);

  const initializeTracker = useCallback(async () => {
    const files = (await listWorkspaceFiles()).filter(
      (item) => !item.isDirectory && isTextFilePath(item.path),
    );
    const trackedPaths: Record<string, string> = {};
    for (const entry of files) {
      const content = await readFileAsTextSafe(entry.path);
      if (content === null) {
        continue;
      }
      trackedPaths[entry.path] = quickHash(content);
    }

    const next: TrackerState = {
      initialized: true,
      trackedPaths,
      stagedPaths: [],
      commits: trackerState.commits,
    };
    await persistTrackerState(next);
    await addCommandHistory("Tracker Init");
  }, [
    addCommandHistory,
    listWorkspaceFiles,
    persistTrackerState,
    readFileAsTextSafe,
    trackerState.commits,
  ]);

  const trackerStatusMap = useMemo(() => {
    const map: Record<string, "A" | "M"> = {};
    if (!trackerState.initialized) {
      return map;
    }
    for (const entry of entries) {
      if (entry.isDirectory) {
        continue;
      }
      if (!(entry.path in trackerState.trackedPaths)) {
        map[entry.path] = "A";
      }
    }
    for (const tab of tabs) {
      const trackedHash = trackerState.trackedPaths[tab.path];
      if (!trackedHash) {
        map[tab.path] = "A";
      } else if (quickHash(tab.content) !== trackedHash) {
        map[tab.path] = "M";
      }
    }
    return map;
  }, [entries, tabs, trackerState]);

  const trackerChangedPaths = useMemo(
    () => Object.keys(trackerStatusMap).sort((left, right) => left.localeCompare(right)),
    [trackerStatusMap],
  );

  const toggleStagePath = useCallback(
    async (path: string) => {
      const staged = trackerState.stagedPaths.includes(path);
      const next = {
        ...trackerState,
        stagedPaths: staged
          ? trackerState.stagedPaths.filter((item) => item !== path)
          : [...trackerState.stagedPaths, path],
      };
      await persistTrackerState(next);
    },
    [persistTrackerState, trackerState],
  );

  const stageAllChanges = useCallback(async () => {
    const changed = Object.keys(trackerStatusMap);
    const next = {
      ...trackerState,
      stagedPaths: Array.from(new Set([...trackerState.stagedPaths, ...changed])),
    };
    await persistTrackerState(next);
  }, [persistTrackerState, trackerState, trackerStatusMap]);

  const commitTracker = useCallback(async () => {
    if (!trackerState.initialized) {
      Alert.alert("Tracker", "Initialize tracker first.");
      return;
    }
    const message = trackerCommitMessage.trim();
    if (!message) {
      Alert.alert("Commit Message", "Enter a commit message.");
      return;
    }
    if (!trackerState.stagedPaths.length) {
      Alert.alert("No Staged Files", "Stage changes before committing.");
      return;
    }

    const nextTracked = { ...trackerState.trackedPaths };
    for (const path of trackerState.stagedPaths) {
      const inTab = tabs.find((tab) => tab.path === path);
      if (inTab) {
        nextTracked[path] = quickHash(inTab.content);
        continue;
      }
      const content = await readFileAsTextSafe(path);
      if (content !== null) {
        nextTracked[path] = quickHash(content);
      }
    }

    const commit: TrackerCommit = {
      id: `${Date.now()}-${Math.random().toString(16).slice(2)}`,
      message,
      timestamp: Date.now(),
      files: trackerState.stagedPaths,
    };
    const next: TrackerState = {
      initialized: true,
      trackedPaths: nextTracked,
      stagedPaths: [],
      commits: [commit, ...trackerState.commits].slice(0, 40),
    };
    await persistTrackerState(next);
    setTrackerCommitMessage("");
    await addCommandHistory(`Commit: ${message}`);
  }, [
    addCommandHistory,
    persistTrackerState,
    readFileAsTextSafe,
    tabs,
    trackerCommitMessage,
    trackerState,
  ]);

  const resolveTerminalPath = useCallback(
    (target?: string) => {
      const raw = (target ?? "").trim();
      const resolved = raw
        ? (raw.startsWith("/") ? raw : joinFsPath(currentDirectory, raw))
        : currentDirectory;
      return pathIsWithin(resolved, WORKSPACE_ROOT) ? resolved : null;
    },
    [currentDirectory],
  );

  const terminalLs = useCallback(
    async (target?: string) => {
      const resolved = resolveTerminalPath(target);
      if (!resolved) {
        throw new Error("Path is outside workspace.");
      }
      const names = await FileSystem.readDirectoryAsync(resolved);
      return names.sort().join("  ");
    },
    [resolveTerminalPath],
  );

  const runTerminalCommand = useCallback(async () => {
    const raw = terminalInput.trim();
    if (!raw) {
      return;
    }

    appendTerminalLog("input", `$ ${raw}`);
    setTerminalInput("");

    const [cmd, ...rest] = raw.split(" ");
    const arg = rest.join(" ").trim();

    try {
      switch (cmd) {
        case "help":
          appendTerminalLog(
            "output",
            "help, pwd, ls [path], cat <file>, touch <file>, mkdir <dir>, rm <path>, mv <from> <to>, echo <text>",
          );
          break;
        case "pwd":
          appendTerminalLog("output", formatRelativePath(currentDirectory));
          break;
        case "ls":
          appendTerminalLog("output", await terminalLs(arg || undefined));
          break;
        case "cat": {
          const target = resolveTerminalPath(arg);
          if (!target) {
            appendTerminalLog("error", "Path is outside workspace.");
            break;
          }
          const content = await readFileAsTextSafe(target);
          appendTerminalLog("output", content ?? "[binary or unreadable]");
          break;
        }
        case "touch": {
          if (!arg) {
            appendTerminalLog("error", "touch requires a filename.");
            break;
          }
          const target = resolveTerminalPath(arg);
          if (!target) {
            appendTerminalLog("error", "Path is outside workspace.");
            break;
          }
          if (readOnlyMode || isProtectedPath(target)) {
            appendTerminalLog("error", "Path is read-only or protected.");
            break;
          }
          await FileSystem.writeAsStringAsync(target, "", {
            encoding: FileSystem.EncodingType.UTF8,
          });
          appendTerminalLog("output", `created ${target}`);
          await refreshCurrentDirectory();
          break;
        }
        case "mkdir": {
          if (!arg) {
            appendTerminalLog("error", "mkdir requires a folder name.");
            break;
          }
          const target = resolveTerminalPath(arg);
          if (!target) {
            appendTerminalLog("error", "Path is outside workspace.");
            break;
          }
          if (readOnlyMode || isProtectedPath(target)) {
            appendTerminalLog("error", "Path is read-only or protected.");
            break;
          }
          await FileSystem.makeDirectoryAsync(target, { intermediates: true });
          appendTerminalLog("output", `created ${target}`);
          await refreshCurrentDirectory();
          break;
        }
        case "rm": {
          if (!arg) {
            appendTerminalLog("error", "rm requires a path.");
            break;
          }
          const target = resolveTerminalPath(arg);
          if (!target) {
            appendTerminalLog("error", "Path is outside workspace.");
            break;
          }
          if (readOnlyMode || isProtectedPath(target)) {
            appendTerminalLog("error", "Path is read-only or protected.");
            break;
          }
          await FileSystem.deleteAsync(target, { idempotent: true });
          appendTerminalLog("output", `deleted ${target}`);
          await refreshCurrentDirectory();
          break;
        }
        case "mv": {
          const from = rest[0];
          const to = rest[1];
          if (!from || !to) {
            appendTerminalLog("error", "mv requires source and destination.");
            break;
          }
          const source = resolveTerminalPath(from);
          const destination = resolveTerminalPath(to);
          if (!source || !destination) {
            appendTerminalLog("error", "Path is outside workspace.");
            break;
          }
          if (readOnlyMode || isProtectedPath(source) || isProtectedPath(destination)) {
            appendTerminalLog("error", "Path is read-only or protected.");
            break;
          }
          await FileSystem.moveAsync({ from: source, to: destination });
          appendTerminalLog("output", `${source} -> ${destination}`);
          await refreshCurrentDirectory();
          break;
        }
        case "echo":
          appendTerminalLog("output", arg);
          break;
        default:
          appendTerminalLog("error", `Unknown command: ${cmd}`);
          break;
      }
    } catch (error) {
      appendTerminalLog("error", `Command failed: ${String(error)}`);
    }
  }, [
    appendTerminalLog,
    currentDirectory,
    isProtectedPath,
    readFileAsTextSafe,
    readOnlyMode,
    refreshCurrentDirectory,
    resolveTerminalPath,
    terminalInput,
    terminalLs,
  ]);

  const togglePathSelection = useCallback((path: string) => {
    setSelectedPaths((prev) =>
      prev.includes(path) ? prev.filter((item) => item !== path) : [...prev, path],
    );
  }, []);

  const bulkDeleteSelected = useCallback(async () => {
    if (!selectedPaths.length) {
      return;
    }
    if (readOnlyMode) {
      Alert.alert("Read Only", "Disable read-only mode to delete.");
      return;
    }

    for (const path of selectedPaths) {
      if (isProtectedPath(path)) {
        continue;
      }
      await FileSystem.deleteAsync(path, { idempotent: true });
    }
    setSelectedPaths([]);
    setSelectionMode(false);
    await refreshCurrentDirectory();
  }, [isProtectedPath, readOnlyMode, refreshCurrentDirectory, selectedPaths]);

  const bulkMoveSelectedToCurrent = useCallback(async () => {
    if (!selectedPaths.length) {
      return;
    }
    if (readOnlyMode) {
      Alert.alert("Read Only", "Disable read-only mode to move.");
      return;
    }

    for (const path of selectedPaths) {
      if (pathIsWithin(currentDirectory, path) || isProtectedPath(path)) {
        continue;
      }
      const destination = joinFsPath(currentDirectory, basename(path));
      const exists = await FileSystem.getInfoAsync(destination);
      if (exists.exists) {
        continue;
      }
      await FileSystem.moveAsync({ from: path, to: destination });
    }
    setSelectedPaths([]);
    setSelectionMode(false);
    await refreshCurrentDirectory();
  }, [currentDirectory, isProtectedPath, readOnlyMode, refreshCurrentDirectory, selectedPaths]);

  const togglePinFolder = useCallback(
    async (path: string) => {
      const exists = pinnedFolders.includes(path);
      const next = exists
        ? pinnedFolders.filter((item) => item !== path)
        : [path, ...pinnedFolders];
      await persistPinnedFolders(next);
    },
    [persistPinnedFolders, pinnedFolders],
  );

  const toggleProtectPath = useCallback(
    async (path: string) => {
      const exists = protectedPaths.includes(path);
      const next = exists
        ? protectedPaths.filter((item) => item !== path)
        : [path, ...protectedPaths];
      await persistProtectedPaths(next);
    },
    [persistProtectedPaths, protectedPaths],
  );

  const executePluginCommand = useCallback(
    async (command: PluginCommand) => {
      switch (command.type) {
        case "showMessage":
          Alert.alert("Plugin", command.payload);
          break;
        case "openFile":
          {
            const target = command.payload.startsWith("/")
              ? command.payload
              : joinFsPath(WORKSPACE_ROOT, command.payload);
            if (!pathIsWithin(target, WORKSPACE_ROOT)) {
              Alert.alert("Plugin", "Plugin path is outside workspace.");
              break;
            }
            await openFile(target);
          }
          break;
        case "insertText":
          if (activeTab) {
            await insertSnippetIntoActiveTab(command.payload);
          }
          break;
        default:
          break;
      }
      await addCommandHistory(`Plugin: ${command.label}`);
    },
    [activeTab, addCommandHistory, insertSnippetIntoActiveTab, openFile],
  );

  const outlineSymbols = useMemo(() => {
    if (!activeTab) {
      return [] as Array<{ label: string; line: number }>;
    }
    const lines = activeTab.content.split("\n");
    const symbols: Array<{ label: string; line: number }> = [];
    for (let index = 0; index < lines.length; index += 1) {
      const text = lines[index].trim();
      if (
        text.startsWith("function ") ||
        text.startsWith("class ") ||
        text.startsWith("def ") ||
        text.startsWith("# ")
      ) {
        symbols.push({
          label: text.slice(0, 80),
          line: index + 1,
        });
      }
    }
    return symbols.slice(0, 120);
  }, [activeTab]);

  const createFolder = useCallback(async () => {
    const trimmed = newFolderName.trim();
    if (!trimmed) {
      Alert.alert("Invalid Name", "Enter a folder name.");
      return;
    }
    if (trimmed.includes("/") || trimmed.includes("\\")) {
      Alert.alert("Invalid Name", "Folder names cannot include / or \\.");
      return;
    }

    const destination = joinFsPath(currentDirectory, trimmed);
    if (readOnlyMode || isProtectedPath(destination)) {
      Alert.alert("Read Only", "Target path is protected or read-only.");
      return;
    }

    try {
      const folderInfo = await FileSystem.getInfoAsync(destination);
      if (folderInfo.exists) {
        Alert.alert("Already Exists", "A file or folder with this name already exists.");
        return;
      }

      await FileSystem.makeDirectoryAsync(destination, { intermediates: true });

      setNewFolderModalVisible(false);
      setNewFolderName("new-folder");
      await refreshCurrentDirectory();
      await addCommandHistory(`Create Folder ${trimmed}`);
    } catch (error) {
      console.error(error);
      Alert.alert("Create Error", "Unable to create the folder.");
    }
  }, [
    addCommandHistory,
    currentDirectory,
    isProtectedPath,
    newFolderName,
    readOnlyMode,
    refreshCurrentDirectory,
  ]);

  const resolveDuplicatePath = useCallback(async (entry: FileEntry) => {
    const sourceName = entry.name;
    const extensionIndex = entry.isDirectory ? -1 : sourceName.lastIndexOf(".");
    const base =
      extensionIndex > 0 ? sourceName.slice(0, extensionIndex) : sourceName;
    const extension = extensionIndex > 0 ? sourceName.slice(extensionIndex) : "";
    const folderPath = parentPath(entry.path, WORKSPACE_ROOT);

    for (let counter = 1; counter <= 500; counter += 1) {
      const suffix = counter === 1 ? " copy" : ` copy ${counter}`;
      const candidatePath = joinFsPath(folderPath, `${base}${suffix}${extension}`);
      const candidateInfo = await FileSystem.getInfoAsync(candidatePath);
      if (!candidateInfo.exists) {
        return candidatePath;
      }
    }

    throw new Error("Could not allocate a duplicate name.");
  }, []);

  const duplicateEntry = useCallback(
    async (entry: FileEntry) => {
      try {
        if (readOnlyMode || isProtectedPath(entry.path)) {
          Alert.alert("Read Only", "Selected path is protected or read-only.");
          return;
        }
        const destination = await resolveDuplicatePath(entry);
        if (isProtectedPath(destination)) {
          Alert.alert("Protected", "Destination path is protected.");
          return;
        }
        await FileSystem.copyAsync({
          from: entry.path,
          to: destination,
        });

        setEntryActionModalVisible(false);
        setSelectedEntry(null);
        await refreshCurrentDirectory();
        await addCommandHistory(`Duplicate ${entry.name}`);
      } catch (error) {
        console.error(error);
        Alert.alert("Duplicate Error", "Unable to duplicate the selected item.");
      }
    },
    [addCommandHistory, isProtectedPath, readOnlyMode, refreshCurrentDirectory, resolveDuplicatePath],
  );

  const startRenameEntry = useCallback((entry: FileEntry) => {
    setEntryActionModalVisible(false);
    setSelectedEntry(entry);
    setRenameValue(entry.name);
    setRenameModalVisible(true);
  }, []);

  const commitRenameEntry = useCallback(async () => {
    if (!selectedEntry) {
      return;
    }

    const trimmed = renameValue.trim();
    if (!trimmed) {
      Alert.alert("Invalid Name", "Enter a valid name.");
      return;
    }
    if (trimmed.includes("/") || trimmed.includes("\\")) {
      Alert.alert("Invalid Name", "Names cannot include / or \\.");
      return;
    }

    const destination = joinFsPath(parentPath(selectedEntry.path, WORKSPACE_ROOT), trimmed);
    if (readOnlyMode || isProtectedPath(selectedEntry.path) || isProtectedPath(destination)) {
      Alert.alert("Read Only", "Selected path is protected or read-only.");
      return;
    }
    if (stripTrailingSlash(destination) === stripTrailingSlash(selectedEntry.path)) {
      setRenameModalVisible(false);
      setRenameValue("");
      setSelectedEntry(null);
      return;
    }

    try {
      const destinationInfo = await FileSystem.getInfoAsync(destination);
      if (destinationInfo.exists) {
        Alert.alert("Already Exists", "A file or folder with this name already exists.");
        return;
      }

      await FileSystem.moveAsync({
        from: selectedEntry.path,
        to: destination,
      });

      setTabs((prev) =>
        prev.map((tab) => {
          const nextPath = remapPathPrefix(tab.path, selectedEntry.path, destination);
          if (nextPath === tab.path) {
            return tab;
          }
          return {
            ...tab,
            path: nextPath,
            name: basename(nextPath),
          };
        }),
      );

      await remapRecentEntriesByPrefix(selectedEntry.path, destination);

      if (pathIsWithin(currentDirectory, selectedEntry.path)) {
        setCurrentDirectory(remapPathPrefix(currentDirectory, selectedEntry.path, destination));
      }

      setRenameModalVisible(false);
      setRenameValue("");
      setSelectedEntry(null);
      await refreshCurrentDirectory();
      await addCommandHistory(`Rename ${selectedEntry.name} -> ${trimmed}`);
    } catch (error) {
      console.error(error);
      Alert.alert("Rename Error", "Unable to rename the selected item.");
    }
  }, [
    addCommandHistory,
    currentDirectory,
    refreshCurrentDirectory,
    remapRecentEntriesByPrefix,
    renameValue,
    isProtectedPath,
    readOnlyMode,
    selectedEntry,
  ]);

  const deleteEntryNow = useCallback(
    async (entry: FileEntry) => {
      try {
        if (readOnlyMode || isProtectedPath(entry.path)) {
          Alert.alert("Read Only", "Selected path is protected or read-only.");
          return;
        }
        if (!entry.isDirectory) {
          const currentContent = await readFileAsTextSafe(entry.path);
          if (currentContent !== null) {
            await backupFileIfNeeded(entry.path, currentContent);
          }
        }
        await FileSystem.deleteAsync(entry.path, { idempotent: true });

        const remainingTabs = tabs.filter((tab) => !pathIsWithin(tab.path, entry.path));
        setTabs(remainingTabs);
        if (!remainingTabs.some((tab) => tab.id === activeTabId)) {
          setActiveTabId(remainingTabs[0]?.id ?? null);
        }
        if (!remainingTabs.length) {
          setSearchVisible(false);
        }

        await removeRecentEntriesByPrefix(entry.path);

        setEntryActionModalVisible(false);
        setSelectedEntry(null);
        setRenameModalVisible(false);

        if (pathIsWithin(currentDirectory, entry.path)) {
          setCurrentDirectory(parentPath(entry.path, WORKSPACE_ROOT));
        }

        await refreshCurrentDirectory();
        await addCommandHistory(`Delete ${entry.name}`);
      } catch (error) {
        console.error(error);
        Alert.alert("Delete Error", "Unable to delete the selected item.");
      }
    },
    [
      activeTabId,
      addCommandHistory,
      backupFileIfNeeded,
      currentDirectory,
      isProtectedPath,
      readFileAsTextSafe,
      readOnlyMode,
      refreshCurrentDirectory,
      removeRecentEntriesByPrefix,
      tabs,
    ],
  );

  const requestDeleteEntry = useCallback(
    (entry: FileEntry) => {
      const impactedTabs = tabs.filter((tab) => pathIsWithin(tab.path, entry.path));
      const hasUnsaved = impactedTabs.some((tab) => tab.content !== tab.savedContent);
      const targetType = entry.isDirectory ? "folder" : "file";

      Alert.alert(
        `Delete ${targetType}?`,
        hasUnsaved
          ? `This will permanently delete ${entry.name} and discard unsaved open tabs.`
          : `This will permanently delete ${entry.name}.`,
        [
          { text: "Cancel", style: "cancel" },
          {
            text: "Delete",
            style: "destructive",
            onPress: () => {
              void deleteEntryNow(entry);
            },
          },
        ],
      );
    },
    [deleteEntryNow, tabs],
  );

  const toggleSetting = useCallback(
    async (key: keyof AppSettings) => {
      if (typeof settings[key] !== "boolean") {
        return;
      }

      const next = {
        ...settings,
        [key]: !(settings[key] as boolean),
      };

      await persistSettings(next);
    },
    [persistSettings, settings],
  );

  const cycleTheme = useCallback(async () => {
    const index = THEME_ORDER.indexOf(settings.theme);
    const nextTheme = THEME_ORDER[(index + 1) % THEME_ORDER.length];
    await persistSettings({
      ...settings,
      theme: nextTheme,
    });
  }, [persistSettings, settings]);

  const onWebViewMessage = useCallback(
    (event: { nativeEvent: { data: string } }) => {
      let data: { type?: string; payload?: Record<string, unknown> } = {};

      try {
        data = JSON.parse(event.nativeEvent.data);
      } catch {
        return;
      }

      if (data.type === "ready") {
        syncedTabForWebViewRef.current = null;
        setEditorReady(true);
        sendToEditor({ type: "focus" });
        return;
      }

      if (data.type === "docChange") {
        const content = typeof data.payload?.content === "string" ? data.payload.content : "";
        setCurrentTabContent(content);
        return;
      }

      if (data.type === "cursor" && activeTabId) {
        const line = Number(data.payload?.line ?? 1);
        const col = Number(data.payload?.col ?? 1);

        setTabs((prev) =>
          prev.map((tab) =>
            tab.id === activeTabId
              ? {
                  ...tab,
                  line,
                  col,
                }
              : tab,
          ),
        );
      }
    },
    [activeTabId, sendToEditor, setCurrentTabContent],
  );

  const renderTab = (tab: EditorTab) => {
    const isActive = tab.id === activeTabId;
    const unsaved = tab.content !== tab.savedContent;

    return (
      <View
        key={tab.id}
        style={[
          styles.tabItem,
          isActive ? styles.tabItemActive : null,
          unsaved ? styles.tabItemUnsaved : null,
        ]}
      >
        <Pressable style={styles.tabLabelWrap} onPress={() => setActiveTabId(tab.id)}>
          <Text
            style={[
              styles.tabText,
              isActive ? styles.tabTextActive : null,
              unsaved ? styles.tabTextUnsaved : null,
            ]}
          >
            {tab.name}
            {unsaved ? " *" : ""}
          </Text>
        </Pressable>
        <Pressable style={styles.tabCloseButton} onPress={() => closeTab(tab.id)}>
          <Text style={styles.tabCloseText}>x</Text>
        </Pressable>
      </View>
    );
  };

  const renderBreadcrumb = () => {
    const relative = stripTrailingSlash(currentDirectory)
      .replace(`${stripTrailingSlash(WORKSPACE_ROOT)}/`, "")
      .replace(stripTrailingSlash(WORKSPACE_ROOT), "");

    const segments = relative ? relative.split("/").filter(Boolean) : [];

    const nodes: { label: string; path: string }[] = [{ label: "workspace", path: WORKSPACE_ROOT }];

    let rollingPath = WORKSPACE_ROOT;
    for (const segment of segments) {
      rollingPath = joinFsPath(rollingPath, segment);
      nodes.push({ label: segment, path: rollingPath });
    }

    return (
      <ScrollView horizontal style={styles.breadcrumbWrap}>
        {nodes.map((node, index) => (
          <View key={`${node.path}-${index}`} style={styles.breadcrumbNode}>
            <Pressable onPress={() => setCurrentDirectory(node.path)}>
              <Text style={styles.breadcrumbText}>{node.label}</Text>
            </Pressable>
            {index < nodes.length - 1 ? <Text style={styles.breadcrumbDivider}>/</Text> : null}
          </View>
        ))}
      </ScrollView>
    );
  };

  const renderHomeScreen = () => (
    <View style={styles.screen}>
      <View style={styles.header}>
        <Text style={styles.headerTitle}>[IPCoder]</Text>
        <ScrollView
          horizontal
          style={styles.headerActionsScroll}
          contentContainerStyle={styles.headerActions}
          showsHorizontalScrollIndicator={false}
        >
          <Pressable style={styles.headerButton} onPress={() => setNewFileModalVisible(true)}>
            <Text style={styles.headerButtonText}>[+] New File</Text>
          </Pressable>
          <Pressable style={styles.headerButton} onPress={() => setNewFolderModalVisible(true)}>
            <Text style={styles.headerButtonText}>[+] New Folder</Text>
          </Pressable>
          <Pressable style={styles.headerButton} onPress={() => setCommandPaletteVisible(true)}>
            <Text style={styles.headerButtonText}>[Cmd]</Text>
          </Pressable>
          <Pressable style={styles.headerButton} onPress={() => setWorkspaceSearchVisible(true)}>
            <Text style={styles.headerButtonText}>[Search+]</Text>
          </Pressable>
          <Pressable
            style={styles.headerButton}
            onPress={() => {
              if (tabs.length) {
                setScreen("editor");
              }
            }}
          >
            <Text style={styles.headerButtonText}>[Editor]</Text>
          </Pressable>
          <Pressable style={styles.headerButton} onPress={() => setTrackerVisible(true)}>
            <Text style={styles.headerButtonText}>[Tracker]</Text>
          </Pressable>
          <Pressable style={styles.headerButton} onPress={() => setTerminalVisible(true)}>
            <Text style={styles.headerButtonText}>[Terminal]</Text>
          </Pressable>
          <Pressable style={styles.headerButton} onPress={() => setScreen("settings")}> 
            <Text style={styles.headerButtonText}>[Settings]</Text>
          </Pressable>
        </ScrollView>
      </View>

      <ScrollView style={styles.scrollArea}>
        <Text style={styles.sectionLabel}>Recent Files</Text>
        {recents.length === 0 ? (
          <Text style={styles.emptyText}>No recent files yet.</Text>
        ) : (
          recents.map((item) => (
            <Pressable
              key={item.path}
              style={styles.fileRow}
              onPress={() => {
                if (isInsideRoot(item.path, WORKSPACE_ROOT)) {
                  void openFile(item.path);
                  return;
                }

                Alert.alert("Missing File", "Recent file no longer exists in workspace.");
              }}
            >
              <Text style={styles.fileRowName}>
                {item.name}
                {unsavedPathSet.has(item.path) ? " [DRAFT]" : ""}
              </Text>
              <Text style={styles.fileRowPath}>{formatRelativePath(item.path)}</Text>
            </Pressable>
          ))
        )}

        <Text style={styles.sectionLabel}>Directory Tree</Text>
        {renderBreadcrumb()}
        <Text style={styles.listHintText}>Long press files/folders for actions.</Text>

        {pinnedFolders.length ? (
          <>
            <Text style={styles.sectionLabel}>Pinned Folders</Text>
            {pinnedFolders.map((path) => (
              <Pressable
                key={path}
                style={styles.fileRow}
                onPress={() => setCurrentDirectory(path)}
                onLongPress={() => {
                  void togglePinFolder(path);
                }}
              >
                <Text style={styles.fileRowDirectory}>[PIN] {basename(path)}</Text>
                <Text style={styles.fileRowPath}>{formatRelativePath(path)}</Text>
              </Pressable>
            ))}
          </>
        ) : null}

        {selectionMode ? (
          <View style={styles.bulkBar}>
            <Text style={styles.bulkBarText}>Selected: {selectedPaths.length}</Text>
            <Pressable style={styles.bulkButton} onPress={() => void bulkMoveSelectedToCurrent()}>
              <Text style={styles.bulkButtonText}>Move Here</Text>
            </Pressable>
            <Pressable style={styles.bulkButtonDanger} onPress={() => void bulkDeleteSelected()}>
              <Text style={styles.bulkButtonDangerText}>Delete</Text>
            </Pressable>
            <Pressable style={styles.bulkButton} onPress={() => setSelectionMode(false)}>
              <Text style={styles.bulkButtonText}>Done</Text>
            </Pressable>
          </View>
        ) : (
          <Pressable style={styles.selectionToggle} onPress={() => setSelectionMode(true)}>
            <Text style={styles.selectionToggleText}>[Select Multiple]</Text>
          </Pressable>
        )}

        {stripTrailingSlash(currentDirectory) !== stripTrailingSlash(WORKSPACE_ROOT) ? (
          <Pressable
            style={styles.fileRow}
            onPress={() => setCurrentDirectory(parentPath(currentDirectory, WORKSPACE_ROOT))}
          >
            <Text style={styles.fileRowDirectory}>[..]</Text>
            <Text style={styles.fileRowPath}>Go to parent directory</Text>
          </Pressable>
        ) : null}

        {entries.map((entry) => (
          <Pressable
            key={entry.path}
            style={styles.fileRow}
            onPress={() => {
              if (selectionMode) {
                togglePathSelection(entry.path);
                return;
              }
              if (entry.isDirectory) {
                setCurrentDirectory(entry.path);
              } else {
                void openFile(entry.path);
              }
            }}
            onLongPress={() => openEntryActionMenu(entry)}
            delayLongPress={250}
          >
            <Text
              style={[
                entry.isDirectory ? styles.fileRowDirectory : styles.fileRowName,
                !entry.isDirectory && unsavedPathSet.has(entry.path) ? styles.fileRowDraft : null,
              ]}
            >
              {selectionMode ? (selectedPaths.includes(entry.path) ? "[X] " : "[ ] ") : ""}
              {entry.isDirectory ? `[DIR] ${entry.name}` : entry.name}
              {!entry.isDirectory && unsavedPathSet.has(entry.path) ? " [DRAFT]" : ""}
              {trackerStatusMap[entry.path] ? ` [${trackerStatusMap[entry.path]}]` : ""}
              {trackerState.stagedPaths.includes(entry.path) ? " [STAGED]" : ""}
            </Text>
            <Text style={styles.fileRowPath}>{formatRelativePath(entry.path)}</Text>
          </Pressable>
        ))}
      </ScrollView>
    </View>
  );

  const renderToolbarButton = (label: string, onPress: () => void, active = false) => (
    <Pressable
      style={[styles.toolbarButton, active ? styles.toolbarButtonActive : null]}
      onPress={onPress}
    >
      <Text style={[styles.toolbarButtonText, active ? styles.toolbarButtonTextActive : null]}>{label}</Text>
    </Pressable>
  );

  const renderEditorBottom = () => {
    if (searchVisible) {
      return (
        <View style={styles.searchPalette}>
          <View style={styles.searchGrid}>
            <View style={styles.searchCell}>
              <Text style={styles.searchLabel}>SEARCH</Text>
              <TextInput
                style={styles.searchInput}
                value={searchState.query}
                onChangeText={(text) =>
                  setSearchState((prev) => ({
                    ...prev,
                    query: text,
                  }))
                }
                autoCapitalize="none"
                autoCorrect={false}
                placeholder="find"
                placeholderTextColor="#555555"
              />
            </View>
            <View style={styles.searchCell}>
              <Text style={styles.searchLabel}>REPLACE</Text>
              <TextInput
                style={styles.searchInput}
                value={searchState.replace}
                onChangeText={(text) =>
                  setSearchState((prev) => ({
                    ...prev,
                    replace: text,
                  }))
                }
                autoCapitalize="none"
                autoCorrect={false}
                placeholder="replace"
                placeholderTextColor="#555555"
              />
            </View>
          </View>

          <ScrollView horizontal style={styles.searchOptions} contentContainerStyle={styles.searchOptionsContent}>
            {renderToolbarButton(`[Aa] ${searchState.caseSensitive ? "ON" : "OFF"}`, () =>
              setSearchState((prev) => ({ ...prev, caseSensitive: !prev.caseSensitive })),
            )}
            {renderToolbarButton(`[.*] ${searchState.regex ? "ON" : "OFF"}`, () =>
              setSearchState((prev) => ({ ...prev, regex: !prev.regex })),
            )}
            {renderToolbarButton(`[\\b] ${searchState.wholeWord ? "ON" : "OFF"}`, () =>
              setSearchState((prev) => ({ ...prev, wholeWord: !prev.wholeWord })),
            )}
            {renderToolbarButton("Prev", () => sendToEditor({ type: "command", payload: { name: "findPrevious" } }))}
            {renderToolbarButton("Next", () => sendToEditor({ type: "command", payload: { name: "findNext" } }))}
            {renderToolbarButton("Replace", () => sendToEditor({ type: "replaceNext" }))}
            {renderToolbarButton("All", () => sendToEditor({ type: "replaceAll" }))}
            {renderToolbarButton("Close", () => setSearchVisible(false))}
          </ScrollView>
        </View>
      );
    }

    return (
      <View style={styles.toolbarWrap}>
        <ScrollView horizontal contentContainerStyle={styles.toolbarContent}>
          {renderToolbarButton("Undo", () =>
            sendToEditor({ type: "command", payload: { name: "undo" as ToolbarCommand } }),
          )}
          {renderToolbarButton("Redo", () =>
            sendToEditor({ type: "command", payload: { name: "redo" as ToolbarCommand } }),
          )}
          {renderToolbarButton("Search", () => {
            setSearchVisible(true);
            sendToEditor({ type: "command", payload: { name: "search" as ToolbarCommand } });
          })}
          {renderToolbarButton(`Wrap ${settings.wordWrap ? "ON" : "OFF"}`, () => {
            void persistSettings({
              ...settings,
              wordWrap: !settings.wordWrap,
            });
          }, settings.wordWrap)}
          {renderToolbarButton("Indent", () =>
            sendToEditor({ type: "command", payload: { name: "indent" as ToolbarCommand } }),
          )}
          {renderToolbarButton("Comment", () =>
            sendToEditor({ type: "command", payload: { name: "comment" as ToolbarCommand } }),
          )}
          {renderToolbarButton("Format", () => {
            void formatActiveDocument();
          })}
          {renderToolbarButton("Snippet", () => setSnippetVisible(true))}
          {renderToolbarButton("Cmd", () => setCommandPaletteVisible(true))}
          {renderToolbarButton(`Outline ${outlineVisible ? "ON" : "OFF"}`, () =>
            setOutlineVisible((prev) => !prev),
          )}
          {renderToolbarButton(`MiniMap ${showMiniMap ? "ON" : "OFF"}`, () =>
            setShowMiniMap((prev) => !prev),
          )}
          {renderToolbarButton(`Theme ${settings.theme}`, () => {
            void cycleTheme();
          })}
        </ScrollView>
      </View>
    );
  };

  const renderEditorScreen = () => (
    <View style={styles.screen}>
      <View style={styles.header}>
        <Text style={styles.headerTitle}>[IPCoder]</Text>
        <ScrollView
          horizontal
          style={styles.headerActionsScroll}
          contentContainerStyle={styles.headerActions}
          showsHorizontalScrollIndicator={false}
        >
          <Pressable style={styles.headerButton} onPress={() => setScreen("home")}> 
            <Text style={styles.headerButtonText}>[Files]</Text>
          </Pressable>
          <Pressable style={styles.headerButton} onPress={() => setCommandPaletteVisible(true)}>
            <Text style={styles.headerButtonText}>[Cmd]</Text>
          </Pressable>
          <Pressable style={styles.headerButton} onPress={() => void saveActiveTab()}>
            <Text style={styles.headerButtonText}>[Save]</Text>
          </Pressable>
          <Pressable style={styles.headerButton} onPress={() => setSnippetVisible(true)}>
            <Text style={styles.headerButtonText}>[Snippet]</Text>
          </Pressable>
          <Pressable style={styles.headerButton} onPress={() => setScreen("settings")}> 
            <Text style={styles.headerButtonText}>[Settings]</Text>
          </Pressable>
        </ScrollView>
      </View>

      <ScrollView horizontal style={styles.tabStrip} contentContainerStyle={styles.tabStripContent}>
        {tabs.map(renderTab)}
      </ScrollView>

      <KeyboardAvoidingView
        style={styles.editorArea}
        behavior={Platform.OS === "ios" ? "padding" : undefined}
      >
        <View style={styles.editorSurfaceRow}>
          <View style={styles.editorSurfaceMain}>
            {editorHtml ? (
              <WebView
                ref={webviewRef}
                originWhitelist={["*"]}
                source={{ html: editorHtml }}
                onMessage={onWebViewMessage}
                javaScriptEnabled
                allowFileAccess
                allowUniversalAccessFromFileURLs
                setSupportMultipleWindows={false}
                style={styles.webview}
                onError={() => {
                  Alert.alert("WebView Error", "Failed to render offline CodeMirror surface.");
                }}
              />
            ) : (
              <View style={styles.loadingWrap}>
                <Text style={styles.loadingText}>Loading local editor bundle...</Text>
              </View>
            )}
          </View>

          {showMiniMap && activeTab ? (
            <View style={styles.miniMapWrap}>
              <Text style={styles.miniMapTitle}>MAP</Text>
              <ScrollView style={styles.miniMapScroll}>
                {activeTab.content
                  .split("\n")
                  .slice(0, 300)
                  .map((line, index) => (
                    <Text key={`${index}-${line.length}`} style={styles.miniMapLine}>
                      {line.slice(0, 40)}
                    </Text>
                  ))}
              </ScrollView>
            </View>
          ) : null}
        </View>

        {outlineVisible && activeTab ? (
          <View style={styles.outlinePanel}>
            <View style={styles.outlineHeader}>
              <Text style={styles.outlineTitle}>OUTLINE</Text>
              <Pressable onPress={() => setOutlineVisible(false)}>
                <Text style={styles.outlineCloseText}>[X]</Text>
              </Pressable>
            </View>
            <ScrollView style={styles.outlineScroll}>
              {outlineSymbols.length ? (
                outlineSymbols.map((symbol) => (
                  <Pressable
                    key={`${symbol.line}-${symbol.label}`}
                    style={styles.outlineRow}
                    onPress={() => {
                      void goToLine(String(symbol.line));
                    }}
                  >
                    <Text style={styles.outlineRowText}>
                      {symbol.line}: {symbol.label}
                    </Text>
                  </Pressable>
                ))
              ) : (
                <Text style={styles.outlineEmpty}>No symbols detected.</Text>
              )}
            </ScrollView>
          </View>
        ) : null}

        {!activeTab ? (
          <View style={styles.noTabWrap}>
            <Text style={styles.emptyText}>No file open.</Text>
            <Pressable style={styles.headerButton} onPress={() => setScreen("home")}>
              <Text style={styles.headerButtonText}>Return to File Manager</Text>
            </Pressable>
          </View>
        ) : null}

        {renderEditorBottom()}

        <View style={styles.statusBarWrap}>
          <Text style={styles.statusBarText}>
            {activeTab ? activeTab.language.toUpperCase() : "TEXT"}
          </Text>
          <Text style={styles.statusBarText}>UTF-8</Text>
          <Text style={styles.statusBarText}>Tab {settings.tabSize}</Text>
          <Text style={styles.statusBarText}>
            Ln {activeTab?.line ?? 1}, Col {activeTab?.col ?? 1}
          </Text>
        </View>
      </KeyboardAvoidingView>
    </View>
  );

  const renderSettingsScreen = () => (
    <View style={styles.screen}>
      <View style={styles.header}>
        <Text style={styles.headerTitle}>[Settings]</Text>
        <ScrollView
          horizontal
          style={styles.headerActionsScroll}
          contentContainerStyle={styles.headerActions}
          showsHorizontalScrollIndicator={false}
        >
          <Pressable style={styles.headerButton} onPress={() => setScreen("home")}> 
            <Text style={styles.headerButtonText}>[Back]</Text>
          </Pressable>
        </ScrollView>
      </View>

      <ScrollView style={styles.scrollArea}>
        <Text style={styles.sectionLabel}>Editor</Text>
        <Pressable style={styles.settingRow} onPress={() => void toggleSetting("wordWrap")}> 
          <Text style={styles.settingLabel}>[{settings.wordWrap ? "X" : " "}] Word Wrap</Text>
        </Pressable>
        <Pressable style={styles.settingRow} onPress={() => void toggleSetting("lineNumbers")}> 
          <Text style={styles.settingLabel}>[{settings.lineNumbers ? "X" : " "}] Line Numbers</Text>
        </Pressable>
        <Pressable
          style={styles.settingRow}
          onPress={() => void persistSettings({ ...settings, fontSize: Math.min(24, settings.fontSize + 1) })}
        >
          <Text style={styles.settingLabel}>[ ] Font Size + ({settings.fontSize}px)</Text>
        </Pressable>
        <Pressable
          style={styles.settingRow}
          onPress={() => void persistSettings({ ...settings, fontSize: Math.max(10, settings.fontSize - 1) })}
        >
          <Text style={styles.settingLabel}>[ ] Font Size - ({settings.fontSize}px)</Text>
        </Pressable>
        <Pressable style={styles.settingRow} onPress={() => void cycleTheme()}> 
          <Text style={styles.settingLabel}>[ ] Theme ({settings.theme})</Text>
        </Pressable>

        <Text style={styles.sectionLabel}>System</Text>
        <Pressable style={styles.settingRow} onPress={() => void toggleSetting("showHiddenFiles")}> 
          <Text style={styles.settingLabel}>
            [{settings.showHiddenFiles ? "X" : " "}] Show Hidden Files
          </Text>
        </Pressable>
        <Pressable
          style={styles.settingRow}
          onPress={() => setReadOnlyMode((prev) => !prev)}
        >
          <Text style={styles.settingLabel}>[{readOnlyMode ? "X" : " "}] Read Only Mode</Text>
        </Pressable>
        <Pressable
          style={styles.settingRow}
          onPress={() => setShowMiniMap((prev) => !prev)}
        >
          <Text style={styles.settingLabel}>[{showMiniMap ? "X" : " "}] Show MiniMap</Text>
        </Pressable>
        <Pressable
          style={styles.settingRow}
          onPress={() => setOutlineVisible((prev) => !prev)}
        >
          <Text style={styles.settingLabel}>[{outlineVisible ? "X" : " "}] Outline Panel</Text>
        </Pressable>

        <Text style={styles.sectionLabel}>Protected Paths</Text>
        {protectedPaths.length ? (
          protectedPaths.map((path) => (
            <Pressable
              key={path}
              style={styles.fileRow}
              onPress={() => {
                void toggleProtectPath(path);
              }}
            >
              <Text style={styles.fileRowName}>[UNPROTECT] {basename(path)}</Text>
              <Text style={styles.fileRowPath}>{formatRelativePath(path)}</Text>
            </Pressable>
          ))
        ) : (
          <Text style={styles.emptyText}>No protected paths.</Text>
        )}

        <Text style={styles.sectionLabel}>Plugins</Text>
        {plugins.length ? (
          plugins.map((plugin) => (
            <View key={plugin.id} style={styles.pluginCard}>
              <Text style={styles.pluginTitle}>{plugin.name}</Text>
              {plugin.commands.length ? (
                plugin.commands.slice(0, 8).map((command) => (
                  <Pressable
                    key={`${plugin.id}-${command.id}`}
                    style={styles.pluginCommandButton}
                    onPress={() => {
                      void executePluginCommand(command);
                    }}
                  >
                    <Text style={styles.pluginCommandText}>{command.label}</Text>
                  </Pressable>
                ))
              ) : (
                <Text style={styles.emptyText}>No commands.</Text>
              )}
            </View>
          ))
        ) : (
          <Text style={styles.emptyText}>No local plugins in `workspace/.ipcoder/plugins`.</Text>
        )}
        <Pressable style={styles.settingRow} onPress={() => void loadLocalPlugins()}>
          <Text style={styles.settingLabel}>[ ] Reload Plugins</Text>
        </Pressable>

        <Pressable
          style={styles.resetButton}
          onPress={() => {
            Alert.alert("Reset Settings", "Restore all settings to defaults?", [
              { text: "Cancel", style: "cancel" },
              {
                text: "Reset",
                style: "destructive",
                onPress: () => {
                  void persistSettings(DEFAULT_SETTINGS);
                },
              },
            ]);
          }}
        >
          <Text style={styles.resetButtonText}>RESET TO DEFAULTS</Text>
        </Pressable>
      </ScrollView>
    </View>
  );

  if (!fontsLoaded || !editorHtml) {
    return (
      <View
        style={[
          styles.container,
          {
            paddingTop: insets.top,
            paddingBottom: Math.max(insets.bottom, 8),
          },
        ]}
      >
        <StatusBar barStyle="light-content" backgroundColor="#000000" translucent={false} />
        <View style={styles.loadingWrap}>
          <Text style={styles.loadingText}>{loadingState || "Loading local assets..."}</Text>
        </View>
      </View>
    );
  }

  return (
    <View
      style={[
        styles.container,
        {
          paddingTop: insets.top,
          paddingBottom: Math.max(insets.bottom, 8),
        },
      ]}
    >
      <StatusBar barStyle="light-content" backgroundColor="#000000" translucent={false} />

      {screen === "home" ? renderHomeScreen() : null}
      {screen === "editor" ? renderEditorScreen() : null}
      {screen === "settings" ? renderSettingsScreen() : null}

      <Modal
        visible={entryActionModalVisible && !!selectedEntry}
        transparent
        animationType="none"
      >
        <View style={styles.modalBackdrop}>
          <View style={styles.modalCard}>
            <Text style={styles.modalTitle}>Actions</Text>
            <Text style={styles.modalPath}>
              {selectedEntry ? formatRelativePath(selectedEntry.path) : ""}
            </Text>

            <View style={styles.actionMenuList}>
              <Pressable
                style={styles.actionMenuButton}
                onPress={() => {
                  if (!selectedEntry) {
                    return;
                  }
                  setEntryActionModalVisible(false);
                  setSelectedEntry(null);
                  if (selectedEntry.isDirectory) {
                    setCurrentDirectory(selectedEntry.path);
                    return;
                  }
                  void openFile(selectedEntry.path);
                }}
              >
                <Text style={styles.actionMenuButtonText}>
                  {selectedEntry?.isDirectory ? "Open Folder" : "Open File"}
                </Text>
              </Pressable>

              <Pressable
                style={styles.actionMenuButton}
                onPress={() => {
                  if (!selectedEntry) {
                    return;
                  }
                  startRenameEntry(selectedEntry);
                }}
              >
                <Text style={styles.actionMenuButtonText}>Rename</Text>
              </Pressable>

              <Pressable
                style={styles.actionMenuButton}
                onPress={() => {
                  if (!selectedEntry) {
                    return;
                  }
                  void duplicateEntry(selectedEntry);
                }}
              >
                <Text style={styles.actionMenuButtonText}>Duplicate</Text>
              </Pressable>

              <Pressable
                style={styles.actionMenuButton}
                onPress={() => {
                  if (!selectedEntry) {
                    return;
                  }
                  void toggleProtectPath(selectedEntry.path);
                  setEntryActionModalVisible(false);
                  setSelectedEntry(null);
                }}
              >
                <Text style={styles.actionMenuButtonText}>
                  {selectedEntry && isProtectedPath(selectedEntry.path)
                    ? "Unprotect Path"
                    : "Protect Path"}
                </Text>
              </Pressable>

              {selectedEntry?.isDirectory ? (
                <Pressable
                  style={styles.actionMenuButton}
                  onPress={() => {
                    if (!selectedEntry) {
                      return;
                    }
                    void togglePinFolder(selectedEntry.path);
                    setEntryActionModalVisible(false);
                    setSelectedEntry(null);
                  }}
                >
                  <Text style={styles.actionMenuButtonText}>
                    {selectedEntry && pinnedFolders.includes(selectedEntry.path)
                      ? "Unpin Folder"
                      : "Pin Folder"}
                  </Text>
                </Pressable>
              ) : null}

              <Pressable
                style={[styles.actionMenuButton, styles.actionMenuButtonDanger]}
                onPress={() => {
                  if (!selectedEntry) {
                    return;
                  }
                  requestDeleteEntry(selectedEntry);
                }}
              >
                <Text style={[styles.actionMenuButtonText, styles.actionMenuButtonDangerText]}>
                  Delete
                </Text>
              </Pressable>
            </View>

            <View style={styles.modalActions}>
              <Pressable
                style={styles.modalButton}
                onPress={() => {
                  setEntryActionModalVisible(false);
                  setSelectedEntry(null);
                }}
              >
                <Text style={styles.modalButtonText}>Close</Text>
              </Pressable>
            </View>
          </View>
        </View>
      </Modal>

      <Modal visible={newFolderModalVisible} transparent animationType="none">
        <View style={styles.modalBackdrop}>
          <View style={styles.modalCard}>
            <Text style={styles.modalTitle}>New Folder</Text>
            <Text style={styles.modalPath}>{formatRelativePath(currentDirectory)}</Text>
            <TextInput
              style={styles.modalInput}
              value={newFolderName}
              onChangeText={setNewFolderName}
              autoCapitalize="none"
              autoCorrect={false}
            />
            <View style={styles.modalActions}>
              <Pressable style={styles.modalButton} onPress={() => setNewFolderModalVisible(false)}>
                <Text style={styles.modalButtonText}>Cancel</Text>
              </Pressable>
              <Pressable style={styles.modalButtonPrimary} onPress={() => void createFolder()}>
                <Text style={styles.modalButtonPrimaryText}>Create</Text>
              </Pressable>
            </View>
          </View>
        </View>
      </Modal>

      <Modal visible={newFileModalVisible} transparent animationType="none">
        <View style={styles.modalBackdrop}>
          <View style={styles.modalCard}>
            <Text style={styles.modalTitle}>New File</Text>
            <Text style={styles.modalPath}>{formatRelativePath(currentDirectory)}</Text>
            <TextInput
              style={styles.modalInput}
              value={newFileName}
              onChangeText={setNewFileName}
              autoCapitalize="none"
              autoCorrect={false}
            />
            <View style={styles.modalActions}>
              <Pressable style={styles.modalButton} onPress={() => setNewFileModalVisible(false)}>
                <Text style={styles.modalButtonText}>Cancel</Text>
              </Pressable>
              <Pressable style={styles.modalButtonPrimary} onPress={() => void createFile()}>
                <Text style={styles.modalButtonPrimaryText}>Create</Text>
              </Pressable>
            </View>
          </View>
        </View>
      </Modal>

      <Modal visible={renameModalVisible && !!selectedEntry} transparent animationType="none">
        <View style={styles.modalBackdrop}>
          <View style={styles.modalCard}>
            <Text style={styles.modalTitle}>Rename</Text>
            <Text style={styles.modalPath}>
              {selectedEntry ? formatRelativePath(selectedEntry.path) : ""}
            </Text>
            <TextInput
              style={styles.modalInput}
              value={renameValue}
              onChangeText={setRenameValue}
              autoCapitalize="none"
              autoCorrect={false}
            />
            <View style={styles.modalActions}>
              <Pressable
                style={styles.modalButton}
                onPress={() => {
                  setRenameModalVisible(false);
                  setRenameValue("");
                  setSelectedEntry(null);
                }}
              >
                <Text style={styles.modalButtonText}>Cancel</Text>
              </Pressable>
              <Pressable style={styles.modalButtonPrimary} onPress={() => void commitRenameEntry()}>
                <Text style={styles.modalButtonPrimaryText}>Save</Text>
              </Pressable>
            </View>
          </View>
        </View>
      </Modal>

      <Modal visible={commandPaletteVisible} transparent animationType="none">
        <View style={styles.modalBackdrop}>
          <View style={[styles.modalCard, styles.modalCardTall]}>
            <Text style={styles.modalTitle}>Command Palette</Text>
            <TextInput
              style={styles.modalInput}
              value={commandQuery}
              onChangeText={setCommandQuery}
              autoCapitalize="none"
              autoCorrect={false}
              placeholder="Search commands or files"
              placeholderTextColor="#555555"
            />

            <View style={styles.inlineInputRow}>
              <TextInput
                style={[styles.modalInput, styles.inlineInput]}
                value={goToLineValue}
                onChangeText={setGoToLineValue}
                keyboardType="number-pad"
                placeholder="Go to line"
                placeholderTextColor="#555555"
              />
              <Pressable
                style={styles.modalButtonPrimary}
                onPress={() => {
                  void goToLine(goToLineValue);
                }}
              >
                <Text style={styles.modalButtonPrimaryText}>Go</Text>
              </Pressable>
              <Pressable
                style={styles.modalButton}
                onPress={() => {
                  setCommandPaletteVisible(false);
                  setCommandQuery("");
                  setGoToLineValue("");
                }}
              >
                <Text style={styles.modalButtonText}>Close</Text>
              </Pressable>
            </View>

            <ScrollView
              horizontal
              style={styles.modalActionsStrip}
              contentContainerStyle={styles.modalActionsStripContent}
            >
              <Pressable style={styles.modalButton} onPress={() => void saveActiveTab()}>
                <Text style={styles.modalButtonText}>Save</Text>
              </Pressable>
              <Pressable style={styles.modalButton} onPress={() => void formatActiveDocument()}>
                <Text style={styles.modalButtonText}>Format</Text>
              </Pressable>
              <Pressable style={styles.modalButton} onPress={() => setSnippetVisible(true)}>
                <Text style={styles.modalButtonText}>Snippets</Text>
              </Pressable>
              <Pressable
                style={styles.modalButton}
                onPress={() => {
                  setWorkspaceSearchVisible(true);
                  setCommandPaletteVisible(false);
                }}
              >
                <Text style={styles.modalButtonText}>Search+</Text>
              </Pressable>
              <Pressable
                style={styles.modalButton}
                onPress={() => {
                  setTrackerVisible(true);
                  setCommandPaletteVisible(false);
                }}
              >
                <Text style={styles.modalButtonText}>Tracker</Text>
              </Pressable>
              <Pressable
                style={styles.modalButton}
                onPress={() => {
                  setTerminalVisible(true);
                  setCommandPaletteVisible(false);
                }}
              >
                <Text style={styles.modalButtonText}>Terminal</Text>
              </Pressable>
            </ScrollView>

            <Text style={styles.modalSectionLabel}>Quick Open</Text>
            <ScrollView style={styles.modalList}>
              {quickOpenMatches.length ? (
                quickOpenMatches.map((item) => (
                  <Pressable
                    key={item.path}
                    style={styles.modalListRow}
                    onPress={() => {
                      void openFile(item.path);
                      setCommandPaletteVisible(false);
                      setCommandQuery("");
                    }}
                  >
                    <Text style={styles.modalListRowTitle}>{item.name}</Text>
                    <Text style={styles.modalListRowPath}>{formatRelativePath(item.path)}</Text>
                  </Pressable>
                ))
              ) : (
                <Text style={styles.emptyText}>No file matches.</Text>
              )}
            </ScrollView>

            <Text style={styles.modalSectionLabel}>Plugin Commands</Text>
            <ScrollView style={styles.modalList}>
              {pluginCommandMatches.length ? (
                pluginCommandMatches.map((item) => (
                  <Pressable
                    key={`${item.pluginId}-${item.command.id}`}
                    style={styles.modalListRow}
                    onPress={() => {
                      void executePluginCommand(item.command);
                      setCommandPaletteVisible(false);
                    }}
                  >
                    <Text style={styles.modalListRowTitle}>{item.command.label}</Text>
                    <Text style={styles.modalListRowPath}>{item.pluginName}</Text>
                  </Pressable>
                ))
              ) : (
                <Text style={styles.emptyText}>No matching plugin commands.</Text>
              )}
            </ScrollView>

            <Text style={styles.modalSectionLabel}>Recent Commands</Text>
            <ScrollView style={styles.modalList}>
              {commandHistory.length ? (
                commandHistory.slice(0, 12).map((entry) => (
                  <Text key={entry.id} style={styles.historyRowText}>
                    {entry.label}
                  </Text>
                ))
              ) : (
                <Text style={styles.emptyText}>No history yet.</Text>
              )}
            </ScrollView>
          </View>
        </View>
      </Modal>

      <Modal visible={workspaceSearchVisible} transparent animationType="none">
        <View style={styles.modalBackdrop}>
          <View style={[styles.modalCard, styles.modalCardTall]}>
            <Text style={styles.modalTitle}>Workspace Search</Text>
            <TextInput
              style={styles.modalInput}
              value={workspaceSearchQuery}
              onChangeText={setWorkspaceSearchQuery}
              autoCapitalize="none"
              autoCorrect={false}
              placeholder="Search text"
              placeholderTextColor="#555555"
            />
            <TextInput
              style={[styles.modalInput, styles.modalInputTopGap]}
              value={workspaceReplaceValue}
              onChangeText={setWorkspaceReplaceValue}
              autoCapitalize="none"
              autoCorrect={false}
              placeholder="Replace with"
              placeholderTextColor="#555555"
            />

            <View style={styles.modalActions}>
              <Pressable style={styles.modalButton} onPress={() => void runWorkspaceSearch()}>
                <Text style={styles.modalButtonText}>Find</Text>
              </Pressable>
              <Pressable
                style={styles.modalButtonPrimary}
                onPress={() => void replaceAcrossSearchResults()}
              >
                <Text style={styles.modalButtonPrimaryText}>Replace All</Text>
              </Pressable>
              <Pressable style={styles.modalButton} onPress={() => setWorkspaceSearchVisible(false)}>
                <Text style={styles.modalButtonText}>Close</Text>
              </Pressable>
            </View>

            {workspaceSearchBusy ? (
              <Text style={styles.searchBusyText}>Searching workspace...</Text>
            ) : null}

            <ScrollView style={styles.modalList}>
              {workspaceSearchResults.length ? (
                workspaceSearchResults.map((result, index) => (
                  <Pressable
                    key={`${result.path}-${result.line}-${index}`}
                    style={styles.searchResultRow}
                    onPress={() => {
                      void openSearchResult(result);
                    }}
                  >
                    <Text style={styles.searchResultTitle}>
                      {basename(result.path)}:{result.line}:{result.col}
                    </Text>
                    <Text style={styles.searchResultPath}>{formatRelativePath(result.path)}</Text>
                    <Text style={styles.searchResultSnippet}>{result.snippet}</Text>
                  </Pressable>
                ))
              ) : (
                <Text style={styles.emptyText}>No results.</Text>
              )}
            </ScrollView>
          </View>
        </View>
      </Modal>

      <Modal visible={trackerVisible} transparent animationType="none">
        <View style={styles.modalBackdrop}>
          <View style={[styles.modalCard, styles.modalCardTall]}>
            <Text style={styles.modalTitle}>Workspace Tracker</Text>
            <View style={styles.modalActions}>
              <Pressable style={styles.modalButton} onPress={() => void initializeTracker()}>
                <Text style={styles.modalButtonText}>
                  {trackerState.initialized ? "Re-Init" : "Init"}
                </Text>
              </Pressable>
              <Pressable style={styles.modalButton} onPress={() => void stageAllChanges()}>
                <Text style={styles.modalButtonText}>Stage All</Text>
              </Pressable>
              <Pressable style={styles.modalButton} onPress={() => setTrackerVisible(false)}>
                <Text style={styles.modalButtonText}>Close</Text>
              </Pressable>
            </View>

            <Text style={styles.modalSectionLabel}>Changes</Text>
            <ScrollView style={styles.modalList}>
              {trackerChangedPaths.length ? (
                trackerChangedPaths.map((path) => {
                  const staged = trackerState.stagedPaths.includes(path);
                  const status = trackerStatusMap[path];
                  return (
                    <Pressable
                      key={path}
                      style={styles.trackerRow}
                      onPress={() => {
                        void toggleStagePath(path);
                      }}
                    >
                      <Text style={styles.trackerRowTitle}>
                        [{staged ? "X" : " "}] {status} {basename(path)}
                      </Text>
                      <Text style={styles.trackerRowPath}>{formatRelativePath(path)}</Text>
                    </Pressable>
                  );
                })
              ) : (
                <Text style={styles.emptyText}>No detected changes.</Text>
              )}
            </ScrollView>

            <TextInput
              style={styles.modalInput}
              value={trackerCommitMessage}
              onChangeText={setTrackerCommitMessage}
              autoCapitalize="none"
              autoCorrect={false}
              placeholder="Commit message"
              placeholderTextColor="#555555"
            />
            <View style={styles.modalActions}>
              <Pressable style={styles.modalButtonPrimary} onPress={() => void commitTracker()}>
                <Text style={styles.modalButtonPrimaryText}>Commit</Text>
              </Pressable>
            </View>

            <Text style={styles.modalSectionLabel}>Recent Commits</Text>
            <ScrollView style={styles.modalList}>
              {trackerState.commits.length ? (
                trackerState.commits.slice(0, 12).map((commit) => (
                  <View key={commit.id} style={styles.commitRow}>
                    <Text style={styles.commitRowTitle}>{commit.message}</Text>
                    <Text style={styles.commitRowMeta}>
                      {new Date(commit.timestamp).toLocaleString()} | {commit.files.length} files
                    </Text>
                  </View>
                ))
              ) : (
                <Text style={styles.emptyText}>No commits yet.</Text>
              )}
            </ScrollView>
          </View>
        </View>
      </Modal>

      <Modal visible={terminalVisible} transparent animationType="none">
        <View style={styles.modalBackdrop}>
          <View style={[styles.modalCard, styles.modalCardTall]}>
            <Text style={styles.modalTitle}>Terminal</Text>

            <ScrollView style={styles.terminalLogWrap}>
              {terminalLogs.length ? (
                terminalLogs.map((entry) => (
                  <Text
                    key={entry.id}
                    style={[
                      styles.terminalLine,
                      entry.type === "error"
                        ? styles.terminalLineError
                        : entry.type === "input"
                          ? styles.terminalLineInput
                          : null,
                    ]}
                  >
                    {entry.text}
                  </Text>
                ))
              ) : (
                <Text style={styles.emptyText}>No terminal activity yet.</Text>
              )}
            </ScrollView>

            <View style={styles.inlineInputRow}>
              <TextInput
                style={[styles.modalInput, styles.inlineInput]}
                value={terminalInput}
                onChangeText={setTerminalInput}
                autoCapitalize="none"
                autoCorrect={false}
                onSubmitEditing={() => {
                  void runTerminalCommand();
                }}
                placeholder="type command (help)"
                placeholderTextColor="#555555"
              />
              <Pressable style={styles.modalButtonPrimary} onPress={() => void runTerminalCommand()}>
                <Text style={styles.modalButtonPrimaryText}>Run</Text>
              </Pressable>
            </View>
            <View style={styles.modalActions}>
              <Pressable
                style={styles.modalButton}
                onPress={() => {
                  setTerminalLogs([]);
                }}
              >
                <Text style={styles.modalButtonText}>Clear</Text>
              </Pressable>
              <Pressable style={styles.modalButton} onPress={() => setTerminalVisible(false)}>
                <Text style={styles.modalButtonText}>Close</Text>
              </Pressable>
            </View>
          </View>
        </View>
      </Modal>

      <Modal visible={snippetVisible} transparent animationType="none">
        <View style={styles.modalBackdrop}>
          <View style={styles.modalCard}>
            <Text style={styles.modalTitle}>Snippets</Text>
            <ScrollView style={styles.modalList}>
              {BUILTIN_SNIPPETS.map((snippet) => (
                <Pressable
                  key={snippet.id}
                  style={styles.modalListRow}
                  onPress={() => {
                    void insertSnippetIntoActiveTab(snippet.body);
                  }}
                >
                  <Text style={styles.modalListRowTitle}>{snippet.label}</Text>
                </Pressable>
              ))}
            </ScrollView>

            {pluginInsertCommands.length ? (
              <>
                <Text style={styles.modalSectionLabel}>Plugin Snippets</Text>
                <ScrollView style={styles.modalList}>
                  {pluginInsertCommands.map((item) => (
                    <Pressable
                      key={`${item.pluginId}-${item.command.id}`}
                      style={styles.modalListRow}
                      onPress={() => {
                        void executePluginCommand(item.command);
                        setSnippetVisible(false);
                      }}
                    >
                      <Text style={styles.modalListRowTitle}>{item.command.label}</Text>
                      <Text style={styles.modalListRowPath}>{item.pluginName}</Text>
                    </Pressable>
                  ))}
                </ScrollView>
              </>
            ) : null}

            <View style={styles.modalActions}>
              <Pressable style={styles.modalButton} onPress={() => setSnippetVisible(false)}>
                <Text style={styles.modalButtonText}>Close</Text>
              </Pressable>
            </View>
          </View>
        </View>
      </Modal>
    </View>
  );
}

export default function App() {
  return (
    <SafeAreaProvider>
      <IPCoderApp />
    </SafeAreaProvider>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: "#000000",
  },
  screen: {
    flex: 1,
    backgroundColor: "#000000",
  },
  header: {
    minHeight: 56,
    borderBottomWidth: 1,
    borderBottomColor: "#555555",
    paddingHorizontal: 12,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
  },
  headerTitle: {
    color: "#FFFFFF",
    fontSize: 18,
    fontFamily: "SpaceGrotesk_700Bold",
  },
  headerActions: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    paddingVertical: 6,
    paddingLeft: 6,
    paddingRight: 2,
  },
  headerActionsScroll: {
    flex: 1,
    marginLeft: 10,
  },
  headerButton: {
    paddingHorizontal: 8,
    paddingVertical: 6,
    borderWidth: 1,
    borderColor: "#555555",
    backgroundColor: "#000000",
  },
  headerButtonText: {
    color: "#00FF41",
    fontFamily: "JetBrainsMono_500Medium",
    fontSize: 12,
  },
  scrollArea: {
    flex: 1,
  },
  sectionLabel: {
    color: "#FFFFFF",
    fontFamily: "SpaceGrotesk_700Bold",
    fontSize: 14,
    marginTop: 16,
    marginBottom: 8,
    paddingHorizontal: 12,
  },
  emptyText: {
    color: "#555555",
    fontFamily: "SpaceGrotesk_400Regular",
    fontSize: 13,
    paddingHorizontal: 12,
    paddingVertical: 12,
  },
  breadcrumbWrap: {
    borderTopWidth: 1,
    borderBottomWidth: 1,
    borderColor: "#555555",
    minHeight: 40,
  },
  breadcrumbNode: {
    flexDirection: "row",
    alignItems: "center",
    paddingVertical: 10,
    paddingHorizontal: 6,
  },
  breadcrumbText: {
    color: "#00FF41",
    fontFamily: "JetBrainsMono_500Medium",
    fontSize: 12,
  },
  breadcrumbDivider: {
    color: "#555555",
    marginLeft: 8,
    fontFamily: "JetBrainsMono_500Medium",
  },
  fileRow: {
    minHeight: 48,
    borderBottomWidth: 1,
    borderBottomColor: "#555555",
    paddingHorizontal: 12,
    justifyContent: "center",
  },
  fileRowName: {
    color: "#FFFFFF",
    fontFamily: "SpaceGrotesk_400Regular",
    fontSize: 14,
  },
  fileRowDirectory: {
    color: "#00FF41",
    fontFamily: "JetBrainsMono_500Medium",
    fontSize: 13,
  },
  fileRowPath: {
    color: "#555555",
    fontFamily: "JetBrainsMono_400Regular",
    fontSize: 11,
    marginTop: 2,
  },
  fileRowDraft: {
    color: "#FF003C",
  },
  listHintText: {
    color: "#555555",
    fontFamily: "JetBrainsMono_400Regular",
    fontSize: 11,
    paddingHorizontal: 12,
    paddingVertical: 8,
  },
  bulkBar: {
    borderBottomWidth: 1,
    borderBottomColor: "#555555",
    paddingHorizontal: 12,
    paddingVertical: 8,
    gap: 8,
  },
  bulkBarText: {
    color: "#FFFFFF",
    fontFamily: "JetBrainsMono_500Medium",
    fontSize: 12,
  },
  bulkButton: {
    borderWidth: 1,
    borderColor: "#555555",
    backgroundColor: "#000000",
    paddingHorizontal: 10,
    paddingVertical: 8,
    alignItems: "center",
  },
  bulkButtonText: {
    color: "#FFFFFF",
    fontFamily: "JetBrainsMono_500Medium",
    fontSize: 12,
  },
  bulkButtonDanger: {
    borderWidth: 1,
    borderColor: "#FF003C",
    backgroundColor: "#000000",
    paddingHorizontal: 10,
    paddingVertical: 8,
    alignItems: "center",
  },
  bulkButtonDangerText: {
    color: "#FF003C",
    fontFamily: "JetBrainsMono_500Medium",
    fontSize: 12,
  },
  selectionToggle: {
    borderBottomWidth: 1,
    borderBottomColor: "#555555",
    paddingHorizontal: 12,
    paddingVertical: 10,
  },
  selectionToggleText: {
    color: "#00FF41",
    fontFamily: "JetBrainsMono_500Medium",
    fontSize: 12,
  },
  tabStrip: {
    borderBottomWidth: 1,
    borderBottomColor: "#555555",
    minHeight: 42,
    maxHeight: 42,
  },
  tabStripContent: {
    alignItems: "stretch",
  },
  tabItem: {
    minWidth: 120,
    maxWidth: 220,
    borderRightWidth: 1,
    borderRightColor: "#555555",
    borderTopWidth: 2,
    borderTopColor: "transparent",
    backgroundColor: "#000000",
    flexDirection: "row",
    alignItems: "center",
  },
  tabItemActive: {
    borderTopColor: "#00FF41",
    backgroundColor: "#111111",
  },
  tabItemUnsaved: {
    borderTopColor: "#FF003C",
  },
  tabLabelWrap: {
    flex: 1,
    paddingHorizontal: 8,
    justifyContent: "center",
    minHeight: 40,
  },
  tabText: {
    color: "#AAAAAA",
    fontFamily: "JetBrainsMono_400Regular",
    fontSize: 12,
  },
  tabTextActive: {
    color: "#FFFFFF",
  },
  tabTextUnsaved: {
    color: "#FF003C",
  },
  tabCloseButton: {
    width: 28,
    minHeight: 40,
    borderLeftWidth: 1,
    borderLeftColor: "#555555",
    alignItems: "center",
    justifyContent: "center",
  },
  tabCloseText: {
    color: "#FF003C",
    fontFamily: "JetBrainsMono_500Medium",
    fontSize: 12,
  },
  editorArea: {
    flex: 1,
  },
  editorSurfaceRow: {
    flex: 1,
    flexDirection: "row",
    minHeight: 0,
  },
  editorSurfaceMain: {
    flex: 1,
    minWidth: 0,
  },
  webview: {
    flex: 1,
    backgroundColor: "#000000",
  },
  miniMapWrap: {
    width: 84,
    borderLeftWidth: 1,
    borderLeftColor: "#555555",
    backgroundColor: "#000000",
  },
  miniMapTitle: {
    color: "#00FF41",
    fontFamily: "JetBrainsMono_500Medium",
    fontSize: 10,
    borderBottomWidth: 1,
    borderBottomColor: "#555555",
    paddingHorizontal: 6,
    paddingVertical: 4,
  },
  miniMapScroll: {
    flex: 1,
    paddingHorizontal: 6,
    paddingTop: 4,
  },
  miniMapLine: {
    color: "#555555",
    fontFamily: "JetBrainsMono_400Regular",
    fontSize: 8,
    lineHeight: 10,
  },
  outlinePanel: {
    position: "absolute",
    top: 8,
    right: 8,
    width: 220,
    maxHeight: 260,
    borderWidth: 1,
    borderColor: "#555555",
    backgroundColor: "#000000",
  },
  outlineHeader: {
    minHeight: 30,
    borderBottomWidth: 1,
    borderBottomColor: "#555555",
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingHorizontal: 8,
  },
  outlineTitle: {
    color: "#00FF41",
    fontFamily: "JetBrainsMono_500Medium",
    fontSize: 11,
  },
  outlineCloseText: {
    color: "#FF003C",
    fontFamily: "JetBrainsMono_500Medium",
    fontSize: 11,
  },
  outlineScroll: {
    maxHeight: 228,
  },
  outlineRow: {
    borderBottomWidth: 1,
    borderBottomColor: "#555555",
    paddingHorizontal: 8,
    paddingVertical: 6,
  },
  outlineRowText: {
    color: "#FFFFFF",
    fontFamily: "JetBrainsMono_400Regular",
    fontSize: 11,
  },
  outlineEmpty: {
    color: "#555555",
    fontFamily: "JetBrainsMono_400Regular",
    fontSize: 11,
    paddingHorizontal: 8,
    paddingVertical: 8,
  },
  toolbarWrap: {
    minHeight: 46,
    borderTopWidth: 1,
    borderTopColor: "#555555",
    backgroundColor: "#000000",
  },
  toolbarContent: {
    alignItems: "center",
    paddingHorizontal: 8,
    gap: 8,
  },
  toolbarButton: {
    borderWidth: 1,
    borderColor: "#555555",
    backgroundColor: "#000000",
    paddingHorizontal: 10,
    paddingVertical: 6,
    marginVertical: 6,
  },
  toolbarButtonActive: {
    borderColor: "#00FF41",
    backgroundColor: "#111111",
  },
  toolbarButtonText: {
    color: "#FFFFFF",
    fontFamily: "JetBrainsMono_500Medium",
    fontSize: 12,
  },
  toolbarButtonTextActive: {
    color: "#00FF41",
  },
  searchPalette: {
    borderTopWidth: 1,
    borderTopColor: "#555555",
    backgroundColor: "#000000",
    paddingTop: 8,
    paddingBottom: 6,
    paddingHorizontal: 8,
  },
  searchGrid: {
    flexDirection: "row",
    gap: 8,
  },
  searchCell: {
    flex: 1,
  },
  searchLabel: {
    color: "#00FF41",
    fontFamily: "JetBrainsMono_500Medium",
    fontSize: 11,
    marginBottom: 4,
  },
  searchInput: {
    borderWidth: 1,
    borderColor: "#555555",
    color: "#FFFFFF",
    fontFamily: "JetBrainsMono_400Regular",
    fontSize: 12,
    paddingHorizontal: 8,
    paddingVertical: 6,
    backgroundColor: "#000000",
  },
  searchOptions: {
    marginTop: 8,
  },
  searchOptionsContent: {
    alignItems: "center",
    gap: 8,
    paddingBottom: 2,
  },
  statusBarWrap: {
    height: 24,
    borderTopWidth: 1,
    borderTopColor: "#555555",
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingHorizontal: 8,
    backgroundColor: "#000000",
  },
  statusBarText: {
    color: "#FFFFFF",
    fontFamily: "JetBrainsMono_400Regular",
    fontSize: 11,
  },
  settingRow: {
    minHeight: 48,
    borderBottomWidth: 1,
    borderBottomColor: "#555555",
    justifyContent: "center",
    paddingHorizontal: 12,
  },
  settingLabel: {
    color: "#FFFFFF",
    fontFamily: "JetBrainsMono_500Medium",
    fontSize: 13,
  },
  pluginCard: {
    borderWidth: 1,
    borderColor: "#555555",
    marginHorizontal: 12,
    marginBottom: 10,
    backgroundColor: "#000000",
    padding: 8,
    gap: 6,
  },
  pluginTitle: {
    color: "#00FF41",
    fontFamily: "SpaceGrotesk_700Bold",
    fontSize: 13,
  },
  pluginCommandButton: {
    borderWidth: 1,
    borderColor: "#555555",
    paddingHorizontal: 8,
    paddingVertical: 7,
  },
  pluginCommandText: {
    color: "#FFFFFF",
    fontFamily: "JetBrainsMono_400Regular",
    fontSize: 12,
  },
  resetButton: {
    borderWidth: 1,
    borderColor: "#FF003C",
    backgroundColor: "#000000",
    marginHorizontal: 12,
    marginTop: 20,
    marginBottom: 24,
    paddingVertical: 12,
    alignItems: "center",
  },
  resetButtonText: {
    color: "#FF003C",
    fontFamily: "SpaceGrotesk_700Bold",
    fontSize: 13,
  },
  loadingWrap: {
    flex: 1,
    justifyContent: "center",
    alignItems: "center",
    paddingHorizontal: 20,
  },
  loadingText: {
    color: "#FFFFFF",
    fontFamily: "JetBrainsMono_500Medium",
    fontSize: 13,
    textAlign: "center",
  },
  noTabWrap: {
    position: "absolute",
    top: 60,
    left: 0,
    right: 0,
    alignItems: "center",
    justifyContent: "center",
    pointerEvents: "box-none",
  },
  modalBackdrop: {
    flex: 1,
    backgroundColor: "rgba(0,0,0,0.85)",
    justifyContent: "center",
    paddingHorizontal: 16,
  },
  modalCard: {
    borderWidth: 1,
    borderColor: "#555555",
    backgroundColor: "#000000",
    padding: 12,
  },
  modalCardTall: {
    maxHeight: "92%",
  },
  modalTitle: {
    color: "#FFFFFF",
    fontFamily: "SpaceGrotesk_700Bold",
    fontSize: 16,
    marginBottom: 4,
  },
  modalPath: {
    color: "#555555",
    fontFamily: "JetBrainsMono_400Regular",
    fontSize: 12,
    marginBottom: 10,
  },
  modalInput: {
    borderWidth: 1,
    borderColor: "#555555",
    backgroundColor: "#000000",
    color: "#FFFFFF",
    fontFamily: "JetBrainsMono_400Regular",
    fontSize: 13,
    paddingHorizontal: 8,
    paddingVertical: 8,
  },
  modalInputTopGap: {
    marginTop: 8,
  },
  inlineInputRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    marginTop: 8,
  },
  inlineInput: {
    flex: 1,
  },
  modalActionsStrip: {
    marginTop: 10,
  },
  modalActionsStripContent: {
    alignItems: "center",
    gap: 8,
    paddingBottom: 2,
  },
  modalSectionLabel: {
    color: "#00FF41",
    fontFamily: "JetBrainsMono_500Medium",
    fontSize: 11,
    marginTop: 10,
    marginBottom: 6,
  },
  modalList: {
    maxHeight: 140,
    borderWidth: 1,
    borderColor: "#555555",
    backgroundColor: "#000000",
  },
  modalListRow: {
    borderBottomWidth: 1,
    borderBottomColor: "#555555",
    paddingHorizontal: 8,
    paddingVertical: 8,
  },
  modalListRowTitle: {
    color: "#FFFFFF",
    fontFamily: "JetBrainsMono_500Medium",
    fontSize: 12,
  },
  modalListRowPath: {
    color: "#555555",
    fontFamily: "JetBrainsMono_400Regular",
    fontSize: 11,
    marginTop: 2,
  },
  historyRowText: {
    color: "#FFFFFF",
    fontFamily: "JetBrainsMono_400Regular",
    fontSize: 12,
    borderBottomWidth: 1,
    borderBottomColor: "#555555",
    paddingHorizontal: 8,
    paddingVertical: 8,
  },
  searchBusyText: {
    color: "#00FF41",
    fontFamily: "JetBrainsMono_400Regular",
    fontSize: 12,
    marginTop: 8,
    marginBottom: 4,
  },
  searchResultRow: {
    borderBottomWidth: 1,
    borderBottomColor: "#555555",
    paddingHorizontal: 8,
    paddingVertical: 8,
  },
  searchResultTitle: {
    color: "#FFFFFF",
    fontFamily: "JetBrainsMono_500Medium",
    fontSize: 12,
  },
  searchResultPath: {
    color: "#555555",
    fontFamily: "JetBrainsMono_400Regular",
    fontSize: 11,
    marginTop: 2,
  },
  searchResultSnippet: {
    color: "#00FF41",
    fontFamily: "JetBrainsMono_400Regular",
    fontSize: 11,
    marginTop: 4,
  },
  trackerRow: {
    borderBottomWidth: 1,
    borderBottomColor: "#555555",
    paddingHorizontal: 8,
    paddingVertical: 8,
  },
  trackerRowTitle: {
    color: "#FFFFFF",
    fontFamily: "JetBrainsMono_500Medium",
    fontSize: 12,
  },
  trackerRowPath: {
    color: "#555555",
    fontFamily: "JetBrainsMono_400Regular",
    fontSize: 11,
    marginTop: 2,
  },
  commitRow: {
    borderBottomWidth: 1,
    borderBottomColor: "#555555",
    paddingHorizontal: 8,
    paddingVertical: 8,
  },
  commitRowTitle: {
    color: "#FFFFFF",
    fontFamily: "JetBrainsMono_500Medium",
    fontSize: 12,
  },
  commitRowMeta: {
    color: "#555555",
    fontFamily: "JetBrainsMono_400Regular",
    fontSize: 11,
    marginTop: 2,
  },
  terminalLogWrap: {
    borderWidth: 1,
    borderColor: "#555555",
    maxHeight: 260,
    backgroundColor: "#000000",
    marginTop: 6,
  },
  terminalLine: {
    color: "#FFFFFF",
    fontFamily: "JetBrainsMono_400Regular",
    fontSize: 12,
    paddingHorizontal: 8,
    paddingVertical: 4,
  },
  terminalLineError: {
    color: "#FF003C",
  },
  terminalLineInput: {
    color: "#00FF41",
  },
  actionMenuList: {
    gap: 8,
  },
  actionMenuButton: {
    borderWidth: 1,
    borderColor: "#555555",
    backgroundColor: "#000000",
    paddingHorizontal: 10,
    paddingVertical: 10,
  },
  actionMenuButtonText: {
    color: "#FFFFFF",
    fontFamily: "JetBrainsMono_500Medium",
    fontSize: 12,
  },
  actionMenuButtonDanger: {
    borderColor: "#FF003C",
  },
  actionMenuButtonDangerText: {
    color: "#FF003C",
  },
  modalActions: {
    flexDirection: "row",
    justifyContent: "flex-end",
    gap: 8,
    marginTop: 12,
  },
  modalButton: {
    borderWidth: 1,
    borderColor: "#555555",
    backgroundColor: "#000000",
    paddingHorizontal: 10,
    paddingVertical: 8,
  },
  modalButtonText: {
    color: "#FFFFFF",
    fontFamily: "JetBrainsMono_500Medium",
    fontSize: 12,
  },
  modalButtonPrimary: {
    borderWidth: 1,
    borderColor: "#00FF41",
    backgroundColor: "#111111",
    paddingHorizontal: 10,
    paddingVertical: 8,
  },
  modalButtonPrimaryText: {
    color: "#00FF41",
    fontFamily: "JetBrainsMono_500Medium",
    fontSize: 12,
  },
});
