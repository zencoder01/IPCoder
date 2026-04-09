import { Compartment, EditorSelection, EditorState } from "@codemirror/state";
import {
  EditorView,
  highlightActiveLine,
  highlightActiveLineGutter,
  keymap,
  lineNumbers,
} from "@codemirror/view";
import {
  StreamLanguage,
  bracketMatching,
  defaultHighlightStyle,
  indentOnInput,
  indentUnit,
  syntaxHighlighting,
} from "@codemirror/language";
import {
  defaultKeymap,
  history,
  historyKeymap,
  indentMore,
  indentWithTab,
  redo,
  toggleComment,
  undo,
} from "@codemirror/commands";
import { closeBrackets, closeBracketsKeymap } from "@codemirror/autocomplete";
import {
  SearchQuery,
  closeSearchPanel,
  findNext,
  findPrevious,
  highlightSelectionMatches,
  openSearchPanel,
  replaceAll,
  replaceNext,
  search,
  setSearchQuery,
} from "@codemirror/search";
import { javascript } from "@codemirror/lang-javascript";
import { python } from "@codemirror/lang-python";
import { html } from "@codemirror/lang-html";
import { css } from "@codemirror/lang-css";
import { json } from "@codemirror/lang-json";
import { markdown } from "@codemirror/lang-markdown";
import { sql } from "@codemirror/lang-sql";
import { cpp } from "@codemirror/lang-cpp";
import { java } from "@codemirror/lang-java";
import { php } from "@codemirror/lang-php";
import { rust } from "@codemirror/lang-rust";
import { go } from "@codemirror/lang-go";
import { shell as shellMode } from "@codemirror/legacy-modes/mode/shell";
import { oneDark } from "@codemirror/theme-one-dark";
import { indentationMarkers } from "@replit/codemirror-indentation-markers";
import { dracula } from "@uiw/codemirror-theme-dracula";
import { githubLight } from "@uiw/codemirror-theme-github";

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

type EditorTheme = "one-dark" | "dracula" | "github-light";

interface SearchPayload {
  query: string;
  replace: string;
  caseSensitive: boolean;
  regex: boolean;
  wholeWord: boolean;
}

type BridgeMessage =
  | {
      type: "setDoc";
      payload: { doc: string; language: EditorLanguage };
    }
  | { type: "setTheme"; payload: { theme: EditorTheme } }
  | { type: "setWordWrap"; payload: { enabled: boolean } }
  | { type: "setTabSize"; payload: { size: number } }
  | { type: "setFontSize"; payload: { size: number } }
  | { type: "setLineNumbers"; payload: { enabled: boolean } }
  | { type: "setCursor"; payload: { line: number; col?: number } }
  | {
      type: "search";
      payload: SearchPayload;
    }
  | { type: "replaceNext" }
  | { type: "replaceAll" }
  | {
      type: "command";
      payload: {
        name:
          | "undo"
          | "redo"
          | "search"
          | "closeSearch"
          | "indent"
          | "comment"
          | "findNext"
          | "findPrevious";
      };
    }
  | { type: "focus" }
  | { type: "requestState" };

declare global {
  interface Window {
    ReactNativeWebView?: { postMessage: (message: string) => void };
    __IPCODER_INIT__?: {
      theme?: EditorTheme;
      language?: EditorLanguage;
      wordWrap?: boolean;
      tabSize?: number;
      fontSize?: number;
      lineNumbers?: boolean;
      doc?: string;
    };
  }

  interface Document {
    addEventListener(
      type: "message",
      listener: (event: MessageEvent<string>) => void,
      options?: boolean | AddEventListenerOptions,
    ): void;
  }
}

const languageCompartment = new Compartment();
const themeCompartment = new Compartment();
const wrapCompartment = new Compartment();
const tabCompartment = new Compartment();
const fontCompartment = new Compartment();
const lineNumberCompartment = new Compartment();

const shellLanguage = StreamLanguage.define(shellMode);

const brutalistTheme = EditorView.theme({
  "&": {
    backgroundColor: "#000000",
    color: "#FFFFFF",
    height: "100%",
  },
  ".cm-scroller": {
    fontFamily: "'JetBrainsMonoLocal', 'JetBrains Mono', monospace",
  },
  ".cm-content": {
    caretColor: "#00FF41",
  },
  ".cm-cursor, .cm-dropCursor": {
    borderLeftColor: "#00FF41",
  },
  ".cm-gutters": {
    backgroundColor: "#000000",
    color: "#555555",
    borderRight: "1px solid #555555",
  },
  ".cm-activeLine": {
    backgroundColor: "#111111",
  },
  ".cm-activeLineGutter": {
    backgroundColor: "#111111",
  },
  ".cm-selectionBackground, ::selection": {
    backgroundColor: "rgba(0,255,65,0.35)",
  },
  ".cm-searchMatch": {
    backgroundColor: "#00FF41",
    color: "#000000",
    border: "1px solid #00FF41",
  },
  ".cm-searchMatch.cm-searchMatch-selected": {
    backgroundColor: "#FF003C",
    color: "#FFFFFF",
    border: "1px solid #FF003C",
  },
});

const dynamicFontTheme = (size: number) =>
  EditorView.theme({
    ".cm-content": {
      fontSize: `${size}px`,
    },
    ".cm-gutterElement": {
      fontSize: `${size}px`,
    },
  });

const lineNumberExtensions = (enabled: boolean) =>
  enabled ? [lineNumbers(), highlightActiveLineGutter()] : [];

const resolveLanguage = (language: EditorLanguage) => {
  switch (language) {
    case "javascript":
      return javascript({ jsx: true });
    case "typescript":
      return javascript({ typescript: true });
    case "python":
      return python();
    case "html":
      return html();
    case "css":
      return css();
    case "json":
      return json();
    case "markdown":
      return markdown();
    case "sql":
      return sql();
    case "bash":
      return shellLanguage;
    case "c":
    case "cpp":
      return cpp();
    case "java":
      return java();
    case "php":
      return php({ plain: true });
    case "rust":
      return rust();
    case "go":
      return go();
    default:
      return [];
  }
};

const resolveTheme = (theme: EditorTheme) => {
  switch (theme) {
    case "dracula":
      return dracula;
    case "github-light":
      return githubLight;
    case "one-dark":
    default:
      return oneDark;
  }
};

const init = window.__IPCODER_INIT__ ?? {};

const postToNative = (type: string, payload: Record<string, unknown> = {}) => {
  if (!window.ReactNativeWebView?.postMessage) {
    return;
  }

  window.ReactNativeWebView.postMessage(JSON.stringify({ type, payload }));
};

const editorRoot = document.getElementById("editor");

if (!editorRoot) {
  throw new Error("Editor root not found");
}

const state = EditorState.create({
  doc: init.doc ?? "",
  extensions: [
    history(),
    search(),
    closeBrackets(),
    bracketMatching(),
    indentOnInput(),
    highlightSelectionMatches(),
    syntaxHighlighting(defaultHighlightStyle, { fallback: true }),
    highlightActiveLine(),
    keymap.of([...defaultKeymap, ...historyKeymap, ...closeBracketsKeymap, indentWithTab]),
    indentationMarkers({
      hideFirstIndent: false,
      markerType: "fullScope",
      colors: {
        dark: "#333333",
        activeDark: "#00FF41",
        light: "#CCCCCC",
        activeLight: "#222222",
      },
    }),
    brutalistTheme,
    languageCompartment.of(resolveLanguage(init.language ?? "text")),
    themeCompartment.of(resolveTheme(init.theme ?? "one-dark")),
    wrapCompartment.of(init.wordWrap ? EditorView.lineWrapping : []),
    tabCompartment.of([EditorState.tabSize.of(init.tabSize ?? 2), indentUnit.of("  ")]),
    fontCompartment.of(dynamicFontTheme(init.fontSize ?? 13)),
    lineNumberCompartment.of(lineNumberExtensions(init.lineNumbers ?? true)),
    EditorView.updateListener.of((update) => {
      if (update.docChanged) {
        postToNative("docChange", { content: update.state.doc.toString() });
      }

      if (update.selectionSet || update.docChanged) {
        const head = update.state.selection.main.head;
        const line = update.state.doc.lineAt(head);
        postToNative("cursor", {
          line: line.number,
          col: head - line.from + 1,
        });
      }
    }),
  ],
});

const view = new EditorView({
  state,
  parent: editorRoot,
});

const applySearchPayload = (payload: SearchPayload) => {
  const query = new SearchQuery({
    search: payload.query,
    replace: payload.replace,
    caseSensitive: payload.caseSensitive,
    regexp: payload.regex,
    wholeWord: payload.wholeWord,
  });

  view.dispatch({
    effects: setSearchQuery.of(query),
  });
};

const handleBridgeMessage = (raw: unknown) => {
  if (typeof raw !== "string") {
    return;
  }

  let message: BridgeMessage;

  try {
    message = JSON.parse(raw) as BridgeMessage;
  } catch {
    return;
  }

  switch (message.type) {
    case "setDoc": {
      const doc = message.payload.doc ?? "";
      const cursorAt = Math.min(view.state.selection.main.head, doc.length);

      view.dispatch({
        changes: { from: 0, to: view.state.doc.length, insert: doc },
        selection: EditorSelection.single(cursorAt),
        effects: languageCompartment.reconfigure(resolveLanguage(message.payload.language)),
      });
      break;
    }
    case "setTheme": {
      view.dispatch({
        effects: themeCompartment.reconfigure(resolveTheme(message.payload.theme)),
      });
      break;
    }
    case "setWordWrap": {
      view.dispatch({
        effects: wrapCompartment.reconfigure(message.payload.enabled ? EditorView.lineWrapping : []),
      });
      break;
    }
    case "setTabSize": {
      const size = Math.max(1, Math.min(8, Math.floor(message.payload.size || 2)));
      view.dispatch({
        effects: tabCompartment.reconfigure([
          EditorState.tabSize.of(size),
          indentUnit.of(" ".repeat(size)),
        ]),
      });
      break;
    }
    case "setFontSize": {
      const size = Math.max(10, Math.min(24, Math.floor(message.payload.size || 13)));
      view.dispatch({
        effects: fontCompartment.reconfigure(dynamicFontTheme(size)),
      });
      break;
    }
    case "setLineNumbers": {
      view.dispatch({
        effects: lineNumberCompartment.reconfigure(lineNumberExtensions(message.payload.enabled)),
      });
      break;
    }
    case "setCursor": {
      const requestedLine = Math.max(1, Math.floor(message.payload.line || 1));
      const requestedCol = Math.max(1, Math.floor(message.payload.col || 1));
      const safeLine = Math.min(requestedLine, view.state.doc.lines);
      const line = view.state.doc.line(safeLine);
      const head = Math.min(line.from + requestedCol - 1, line.to);

      view.dispatch({
        selection: EditorSelection.single(head),
      });
      view.focus();
      break;
    }
    case "search": {
      applySearchPayload(message.payload);
      break;
    }
    case "replaceNext": {
      replaceNext(view);
      break;
    }
    case "replaceAll": {
      replaceAll(view);
      break;
    }
    case "command": {
      switch (message.payload.name) {
        case "undo":
          undo(view);
          break;
        case "redo":
          redo(view);
          break;
        case "search":
          openSearchPanel(view);
          break;
        case "closeSearch":
          closeSearchPanel(view);
          break;
        case "indent":
          indentMore(view);
          break;
        case "comment":
          toggleComment(view);
          break;
        case "findNext":
          findNext(view);
          break;
        case "findPrevious":
          findPrevious(view);
          break;
        default:
          break;
      }
      break;
    }
    case "focus": {
      view.focus();
      break;
    }
    case "requestState": {
      postToNative("docChange", { content: view.state.doc.toString() });
      const head = view.state.selection.main.head;
      const line = view.state.doc.lineAt(head);
      postToNative("cursor", {
        line: line.number,
        col: head - line.from + 1,
      });
      break;
    }
    default:
      break;
  }
};

window.addEventListener("message", (event) => {
  handleBridgeMessage(event.data);
});

document.addEventListener("message", (event) => {
  handleBridgeMessage(event.data);
});

postToNative("ready");
postToNative("docChange", { content: view.state.doc.toString() });
postToNative("cursor", { line: 1, col: 1 });
