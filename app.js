const STORAGE_KEY = "taskBoard2MemoViewerSettings_v1";

const statusText = document.querySelector("#statusText");
const settingsDetails = document.querySelector("#settingsDetails");
const appKeyInput = document.querySelector("#appKeyInput");
const pathInput = document.querySelector("#pathInput");
const authCodeInput = document.querySelector("#authCodeInput");
const saveSettingsButton = document.querySelector("#saveSettingsButton");
const connectButton = document.querySelector("#connectButton");
const saveTokenButton = document.querySelector("#saveTokenButton");
const disconnectButton = document.querySelector("#disconnectButton");
const refreshButton = document.querySelector("#refreshButton");
const copyButton = document.querySelector("#copyButton");
const memoView = document.querySelector("#memoView");
const rawMemoText = document.querySelector("#rawMemoText");
const lastFetchedText = document.querySelector("#lastFetchedText");
const jsonUpdatedText = document.querySelector("#jsonUpdatedText");
const memoSourceText = document.querySelector("#memoSourceText");
const rootKeysText = document.querySelector("#rootKeysText");
const memoCandidatesText = document.querySelector("#memoCandidatesText");

let settings = {
  appKey: "",
  path: "/tasks.json",
  refreshToken: "",
  codeVerifier: ""
};

let currentMemoText = "";

function setStatus(text, kind = "") {
  statusText.textContent = text;
  statusText.dataset.kind = kind;
}

function loadSettings() {
  try {
    settings = {
      ...settings,
      ...(JSON.parse(localStorage.getItem(STORAGE_KEY) || "{}"))
    };
  } catch {
    // 壊れた設定は初期値で上書きする
    saveSettings();
  }

  appKeyInput.value = settings.appKey || "";
  pathInput.value = settings.path || "/tasks.json";
}

function saveSettings() {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(settings));
}

function normalizeDropboxPath(path) {
  const trimmed = String(path || "").trim();
  if (!trimmed) return "/tasks.json";
  return trimmed.startsWith("/") ? trimmed : `/${trimmed}`;
}

function randomBase64Url(length = 96) {
  const bytes = new Uint8Array(length);
  crypto.getRandomValues(bytes);
  return base64UrlEncode(bytes);
}

function base64UrlEncode(buffer) {
  const bytes = buffer instanceof ArrayBuffer ? new Uint8Array(buffer) : buffer;
  let binary = "";

  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }

  return btoa(binary)
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "");
}

async function sha256(text) {
  return crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
}

async function openDropboxAuthUrl() {
  settings.appKey = appKeyInput.value.trim();
  settings.path = normalizeDropboxPath(pathInput.value);
  settings.codeVerifier = randomBase64Url(96);

  if (!settings.appKey) {
    setStatus("Dropbox App keyを入力してください。", "error");
    settingsDetails.open = true;
    return;
  }

  saveSettings();

  const challenge = base64UrlEncode(await sha256(settings.codeVerifier));
  const params = new URLSearchParams({
    client_id: settings.appKey,
    response_type: "code",
    token_access_type: "offline",
    code_challenge: challenge,
    code_challenge_method: "S256",
    scope: "files.content.read"
  });

  const url = `https://www.dropbox.com/oauth2/authorize?${params.toString()}`;

  /*
   * スマホブラウザでは非同期処理後の window.open がブロックされることがあるため、
   * 別タブではなく同じタブでDropbox認証画面へ移動する。
   * 認証コードが表示されたら、このページへ戻ってコードを貼り付ける。
   */
  setStatus("Dropbox認証ページへ移動します。認証コードが表示されたら、このページへ戻って貼り付けてください。");
  window.location.href = url;
}

async function exchangeAuthCode() {
  const code = authCodeInput.value.trim();

  if (!settings.appKey) {
    setStatus("先にDropbox App keyを保存してください。", "error");
    settingsDetails.open = true;
    return;
  }

  if (!settings.codeVerifier) {
    setStatus("先にDropbox接続URLを開いてください。", "error");
    settingsDetails.open = true;
    return;
  }

  if (!code) {
    setStatus("認証コードを貼り付けてください。", "error");
    settingsDetails.open = true;
    return;
  }

  setStatus("Dropbox認証中…");

  const body = new URLSearchParams({
    code,
    grant_type: "authorization_code",
    client_id: settings.appKey,
    code_verifier: settings.codeVerifier
  });

  const response = await fetch("https://api.dropboxapi.com/oauth2/token", {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded"
    },
    body
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Dropbox認証に失敗しました。${text}`);
  }

  const result = await response.json();
  settings.refreshToken = result.refresh_token || "";
  settings.codeVerifier = "";
  authCodeInput.value = "";
  saveSettings();

  setStatus("Dropbox接続済み。");
  settingsDetails.open = false;
  await refreshMemo();
}

async function getAccessToken() {
  if (!settings.appKey || !settings.refreshToken) {
    throw new Error("Dropbox未接続です。Dropbox設定から接続してください。");
  }

  const body = new URLSearchParams({
    grant_type: "refresh_token",
    refresh_token: settings.refreshToken,
    client_id: settings.appKey
  });

  const response = await fetch("https://api.dropboxapi.com/oauth2/token", {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded"
    },
    body
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Dropboxトークン更新に失敗しました。${text}`);
  }

  const result = await response.json();
  return result.access_token;
}

async function downloadDropboxJson() {
  const token = await getAccessToken();
  const path = normalizeDropboxPath(settings.path);

  const response = await fetch("https://content.dropboxapi.com/2/files/download", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Dropbox-API-Arg": JSON.stringify({ path })
    }
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Dropboxファイル読込に失敗しました。${text}`);
  }

  const text = await response.text();
  return JSON.parse(text);
}

function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function getByPath(object, path) {
  return path.split(".").reduce((current, key) => current?.[key], object);
}

function collectMemoCandidates(state) {
  const candidates = [];

  const addCandidate = (path, value, score = 0) => {
    if (typeof value !== "string") return;

    candidates.push({
      path,
      value,
      score,
      length: value.length
    });
  };

  const preferredPaths = [
    ["memoText", 100],
    ["boardMemoText", 98],
    ["memoPanelText", 96],
    ["leftMemoText", 95],
    ["sideMemoText", 95],
    ["memo", 90],
    ["memo.text", 88],
    ["memo.value", 88],
    ["memo.body", 86],
    ["memo.content", 86],
    ["memoPanel.text", 88],
    ["memoPanel.value", 88],
    ["memoPanel.body", 86],
    ["memoPanel.content", 86],
    ["board.memoText", 82],
    ["board.memo", 80],
    ["board.memo.text", 80],
    ["ui.memoText", 78],
    ["settings.memoText", 70]
  ];

  for (const [path, score] of preferredPaths) {
    addCandidate(path, getByPath(state, path), score);
  }

  const visited = new WeakSet();

  const walk = (value, path, depth = 0) => {
    if (depth > 5) return;
    if (!isPlainObject(value) && !Array.isArray(value)) return;
    if (visited.has(value)) return;
    visited.add(value);

    const entries = Array.isArray(value)
      ? value.entries()
      : Object.entries(value);

    for (const [rawKey, child] of entries) {
      const key = String(rawKey);
      const childPath = path ? `${path}.${key}` : key;
      const lowerPath = childPath.toLowerCase();
      const lowerKey = key.toLowerCase();

      if (typeof child === "string" && lowerKey.includes("memo")) {
        let score = 40;

        if (!lowerPath.includes("tasks.") && !lowerPath.includes("columns.")) {
          score += 20;
        }

        if (lowerKey === "memotext") score += 35;
        if (lowerKey === "memo") score += 25;

        addCandidate(childPath, child, score);
      }

      if (isPlainObject(child) || Array.isArray(child)) {
        walk(child, childPath, depth + 1);
      }
    }
  };

  walk(state, "", 0);

  const unique = new Map();
  for (const candidate of candidates) {
    if (!unique.has(candidate.path)) {
      unique.set(candidate.path, candidate);
    }
  }

  return [...unique.values()]
    .sort((a, b) => {
      if (b.score !== a.score) return b.score - a.score;
      return b.length - a.length;
    });
}

function extractMemoText(state) {
  const candidates = collectMemoCandidates(state);
  const best = candidates.find(candidate => candidate.length > 0) ?? candidates[0];

  return {
    text: best?.value ?? "",
    sourcePath: best?.path ?? "",
    candidates
  };
}

function renderDiagnostics(state, extraction) {
  if (memoSourceText) {
    memoSourceText.textContent = extraction.sourcePath || "未検出";
  }

  if (rootKeysText) {
    rootKeysText.textContent = isPlainObject(state)
      ? Object.keys(state).join(", ")
      : "JSON root is not an object";
  }

  if (memoCandidatesText) {
    const lines = extraction.candidates.slice(0, 20).map(candidate => {
      return `${candidate.path} / ${candidate.length.toLocaleString("ja-JP")}文字`;
    });

    memoCandidatesText.textContent = lines.length ? lines.join("\n") : "memo系の候補なし";
  }
}

function formatDateTime(value) {
  if (!value) return "—";

  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return String(value);

  return date.toLocaleString("ja-JP", {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit"
  });
}

function renderMemo(text) {
  currentMemoText = text || "";
  rawMemoText.textContent = currentMemoText;

  memoView.textContent = "";
  memoView.classList.toggle("empty", !currentMemoText);

  if (!currentMemoText) {
    memoView.textContent = "メモ欄は空です。";
    return;
  }

  const lines = currentMemoText.split(/\r?\n/);

  for (const line of lines) {
    const checkMatch = line.match(/^(\s*)[-*]\s+\[( |x|X)\]\s*(.*)$/);

    if (checkMatch) {
      const row = document.createElement("div");
      row.className = "check-line";

      const checkbox = document.createElement("input");
      checkbox.type = "checkbox";
      checkbox.checked = checkMatch[2].toLowerCase() === "x";
      checkbox.disabled = true;

      const text = document.createElement("span");
      text.textContent = `${checkMatch[1] || ""}${checkMatch[3] || ""}`;
      if (checkbox.checked) {
        text.classList.add("checked");
      }

      row.append(checkbox, text);
      memoView.append(row);
      continue;
    }

    const row = document.createElement("div");
    row.className = "memo-line";
    row.textContent = line || "\u00a0";
    memoView.append(row);
  }
}

async function refreshMemo() {
  setStatus("Dropboxから読込中…");

  const state = await downloadDropboxJson();
  const extraction = extractMemoText(state);
  const memoText = extraction.text;

  renderDiagnostics(state, extraction);
  renderMemo(memoText);
  lastFetchedText.textContent = formatDateTime(new Date().toISOString());
  jsonUpdatedText.textContent = formatDateTime(state?.updatedAt);

  const chars = memoText.length;
  if (extraction.sourcePath) {
    setStatus(`読込完了：${chars.toLocaleString("ja-JP")}文字 / 取得元：${extraction.sourcePath}`);
  } else {
    setStatus("読込完了。ただしメモ欄の保存場所を検出できませんでした。", "error");
    settingsDetails.open = true;
  }
}

function disconnectDropbox() {
  settings.refreshToken = "";
  settings.codeVerifier = "";
  saveSettings();
  setStatus("Dropbox接続を解除しました。");
  settingsDetails.open = true;
}

saveSettingsButton.addEventListener("click", () => {
  settings.appKey = appKeyInput.value.trim();
  settings.path = normalizeDropboxPath(pathInput.value);
  saveSettings();
  pathInput.value = settings.path;
  setStatus("設定を保存しました。");
});

connectButton.addEventListener("click", () => {
  openDropboxAuthUrl().catch(error => {
    console.error(error);
    setStatus(error.message, "error");
  });
});

saveTokenButton.addEventListener("click", () => {
  exchangeAuthCode().catch(error => {
    console.error(error);
    setStatus(error.message, "error");
    settingsDetails.open = true;
  });
});

disconnectButton.addEventListener("click", disconnectDropbox);

refreshButton.addEventListener("click", () => {
  refreshMemo().catch(error => {
    console.error(error);
    setStatus(error.message, "error");
    settingsDetails.open = true;
  });
});

copyButton.addEventListener("click", async () => {
  if (!currentMemoText) {
    setStatus("コピーするメモがありません。");
    return;
  }

  await navigator.clipboard.writeText(currentMemoText);
  setStatus("メモをコピーしました。");
});

window.addEventListener("load", () => {
  loadSettings();

  if (settings.refreshToken) {
    setStatus("Dropbox接続済み。更新ボタンで読み込めます。");
    refreshMemo().catch(error => {
      console.error(error);
      setStatus(error.message, "error");
      settingsDetails.open = true;
    });
  } else {
    setStatus("Dropbox未接続。設定を開いて接続してください。");
    settingsDetails.open = true;
  }

  if ("serviceWorker" in navigator) {
    navigator.serviceWorker.register("./service-worker.js").catch(() => {
      // PWAキャッシュ登録に失敗しても閲覧機能には影響しない
    });
  }
});
