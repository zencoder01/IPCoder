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

const STORAGE_SETTINGS_KEY = "ipcoder.settings.v1";
const STORAGE_RECENTS_KEY = "ipcoder.recents.v1";

const DOCUMENT_ROOT =
  FileSystem.documentDirectory ?? FileSystem.cacheDirectory ?? "file:///tmp";
const WORKSPACE_ROOT = `${DOCUMENT_ROOT.replace(/\/$/, "")}/workspace`;

const MAX_RECENT_FILES = 20;
const MAX_TABS = 8;

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

  const activeTab = useMemo(
    () => tabs.find((tab) => tab.id === activeTabId) ?? null,
    [tabs, activeTabId],
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

  const sendToEditor = useCallback((payload: Record<string, unknown>) => {
    if (!webviewRef.current) {
      return;
    }

    webviewRef.current.postMessage(JSON.stringify(payload));
  }, []);

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

  useEffect(() => {
    let cancelled = false;

    const bootstrap = async () => {
      try {
        const [savedSettingsRaw, savedRecentsRaw] = await Promise.all([
          AsyncStorage.getItem(STORAGE_SETTINGS_KEY),
          AsyncStorage.getItem(STORAGE_RECENTS_KEY),
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

        await createWorkspaceIfMissing();
        await loadOfflineEditorAssets();
        if (!cancelled) {
          setLoadingState("");
        }
      } catch (error) {
        console.error(error);
        Alert.alert(
          "Bootstrap Error",
          "Failed to initialize offline editor assets. Verify local bundle generation.",
        );
      }
    };

    void bootstrap();

    return () => {
      cancelled = true;
    };
  }, [createWorkspaceIfMissing, loadOfflineEditorAssets]);

  useEffect(() => {
    void refreshCurrentDirectory();
  }, [refreshCurrentDirectory]);

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

  const saveActiveTab = useCallback(async () => {
    if (!activeTab) {
      return;
    }

    try {
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
    } catch (error) {
      console.error(error);
      Alert.alert("Save Error", "Unable to save the current file.");
    }
  }, [activeTab, refreshCurrentDirectory, touchRecentFile]);

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
    } catch (error) {
      console.error(error);
      Alert.alert("Create Error", "Unable to create the file.");
    }
  }, [currentDirectory, newFileName, openFile, refreshCurrentDirectory]);

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
    } catch (error) {
      console.error(error);
      Alert.alert("Create Error", "Unable to create the folder.");
    }
  }, [currentDirectory, newFolderName, refreshCurrentDirectory]);

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
        const destination = await resolveDuplicatePath(entry);
        await FileSystem.copyAsync({
          from: entry.path,
          to: destination,
        });

        setEntryActionModalVisible(false);
        setSelectedEntry(null);
        await refreshCurrentDirectory();
      } catch (error) {
        console.error(error);
        Alert.alert("Duplicate Error", "Unable to duplicate the selected item.");
      }
    },
    [refreshCurrentDirectory, resolveDuplicatePath],
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
    } catch (error) {
      console.error(error);
      Alert.alert("Rename Error", "Unable to rename the selected item.");
    }
  }, [
    currentDirectory,
    refreshCurrentDirectory,
    remapRecentEntriesByPrefix,
    renameValue,
    selectedEntry,
  ]);

  const deleteEntryNow = useCallback(
    async (entry: FileEntry) => {
      try {
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
      } catch (error) {
        console.error(error);
        Alert.alert("Delete Error", "Unable to delete the selected item.");
      }
    },
    [activeTabId, currentDirectory, refreshCurrentDirectory, removeRecentEntriesByPrefix, tabs],
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
        <View style={styles.headerActions}>
          <Pressable style={styles.headerButton} onPress={() => setNewFileModalVisible(true)}>
            <Text style={styles.headerButtonText}>[+] New File</Text>
          </Pressable>
          <Pressable style={styles.headerButton} onPress={() => setNewFolderModalVisible(true)}>
            <Text style={styles.headerButtonText}>[+] New Folder</Text>
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
          <Pressable style={styles.headerButton} onPress={() => setScreen("settings")}> 
            <Text style={styles.headerButtonText}>[Settings]</Text>
          </Pressable>
        </View>
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
              <Text style={styles.fileRowName}>{item.name}</Text>
              <Text style={styles.fileRowPath}>{formatRelativePath(item.path)}</Text>
            </Pressable>
          ))
        )}

        <Text style={styles.sectionLabel}>Directory Tree</Text>
        {renderBreadcrumb()}
        <Text style={styles.listHintText}>Long press files/folders for actions.</Text>

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
              if (entry.isDirectory) {
                setCurrentDirectory(entry.path);
              } else {
                void openFile(entry.path);
              }
            }}
            onLongPress={() => openEntryActionMenu(entry)}
            delayLongPress={250}
          >
            <Text style={entry.isDirectory ? styles.fileRowDirectory : styles.fileRowName}>
              {entry.isDirectory ? `[DIR] ${entry.name}` : entry.name}
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
        <View style={styles.headerActions}>
          <Pressable style={styles.headerButton} onPress={() => setScreen("home")}> 
            <Text style={styles.headerButtonText}>[Files]</Text>
          </Pressable>
          <Pressable style={styles.headerButton} onPress={() => void saveActiveTab()}>
            <Text style={styles.headerButtonText}>[Save]</Text>
          </Pressable>
          <Pressable style={styles.headerButton} onPress={() => setScreen("settings")}> 
            <Text style={styles.headerButtonText}>[Settings]</Text>
          </Pressable>
        </View>
      </View>

      <ScrollView horizontal style={styles.tabStrip} contentContainerStyle={styles.tabStripContent}>
        {tabs.map(renderTab)}
      </ScrollView>

      <KeyboardAvoidingView
        style={styles.editorArea}
        behavior={Platform.OS === "ios" ? "padding" : undefined}
      >
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
        <View style={styles.headerActions}>
          <Pressable style={styles.headerButton} onPress={() => setScreen("home")}> 
            <Text style={styles.headerButtonText}>[Back]</Text>
          </Pressable>
        </View>
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
  listHintText: {
    color: "#555555",
    fontFamily: "JetBrainsMono_400Regular",
    fontSize: 11,
    paddingHorizontal: 12,
    paddingVertical: 8,
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
  webview: {
    flex: 1,
    backgroundColor: "#000000",
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
