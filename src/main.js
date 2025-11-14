const {
  app,
  BrowserWindow,
  globalShortcut,
  ipcMain,
  clipboard,
  Tray,
  Menu,
  nativeImage,
} = require("electron");
const path = require("path");
const Store = require("electron-store");
const { exec } = require("child_process");
const { promisify } = require("util");

const execAsync = promisify(exec);
const store = new Store();

let mainWindow = null;
let settingsWindow = null;
let previousAppName = null;
let preventAutoHide = false;
let tray = null;

function createMainWindow() {
  mainWindow = new BrowserWindow({
    width: 440,
    height: 340,
    show: false,
    frame: false,
    transparent: true,
    alwaysOnTop: true,
    resizable: false,
    skipTaskbar: true,
    webPreferences: {
      nodeIntegration: true,
      contextIsolation: false,
      enableRemoteModule: true,
    },
  });

  mainWindow.loadFile(path.join(__dirname, "renderer", "index.html"));

  mainWindow.on("blur", () => {
    if (!mainWindow.webContents.isDevToolsOpened() && !preventAutoHide) {
      mainWindow.hide();
    }
  });
}

function createSettingsWindow() {
  if (settingsWindow) {
    settingsWindow.focus();
    return;
  }

  settingsWindow = new BrowserWindow({
    width: 550,
    height: 400,
    webPreferences: {
      nodeIntegration: true,
      contextIsolation: false,
    },
  });

  settingsWindow.loadFile(path.join(__dirname, "renderer", "settings.html"));

  settingsWindow.on("closed", () => {
    settingsWindow = null;
  });
}

function createTray() {
  if (tray) return;
  const image = nativeImage.createEmpty();
  tray = new Tray(image);
  tray.setTitle("🎤");
  tray.setToolTip("Voice Dictation");

  const contextMenu = Menu.buildFromTemplate([
    {
      label: "Начать диктовку",
      click: () => {
        if (mainWindow && mainWindow.isVisible()) {
          mainWindow.webContents.send("toggle-recording");
        } else {
          showDictationWindow();
        }
      },
    },
    { type: "separator" },
    {
      label: "Настройки",
      click: () => {
        createSettingsWindow();
      },
    },
    { type: "separator" },
    { label: "Выход", role: "quit" },
  ]);

  tray.setContextMenu(contextMenu);
  tray.on("click", () => {
    tray.popUpContextMenu();
  });
  tray.on("right-click", () => {
    tray.popUpContextMenu();
  });
}

async function getPreviousApp() {
  try {
    const { stdout } = await execAsync(
      "osascript -e 'tell application \"System Events\" to get name of first application process whose frontmost is true'"
    );
    return stdout.trim();
  } catch (error) {
    console.error("Ошибка получения активного приложения:", error);
    return null;
  }
}

async function activateApp(appName) {
  if (!appName) return;
  try {
    await execAsync(`osascript -e 'tell application "${appName}" to activate'`);
  } catch (error) {
    console.error("Ошибка активации приложения:", error);
  }
}

async function typeTextDirectly(text) {
  try {
    const fs = require("fs");
    const os = require("os");

    const tempFilePath = path.join(
      os.tmpdir(),
      `dictation_text_${Date.now()}.txt`
    );
    fs.writeFileSync(tempFilePath, text, "utf8");

    const typeScript = `
      set textFile to POSIX file "${tempFilePath}"
      set textContent to read textFile as «class utf8»
      
      tell application "System Events"
        keystroke textContent
      end tell
    `;

    const tempScriptPath = path.join(
      os.tmpdir(),
      `dictation_script_${Date.now()}.scpt`
    );
    fs.writeFileSync(tempScriptPath, typeScript);

    await execAsync(`osascript "${tempScriptPath}"`);

    fs.unlinkSync(tempFilePath);
    fs.unlinkSync(tempScriptPath);

    return true;
  } catch (error) {
    console.error("Ошибка прямого ввода текста:", error);
    return false;
  }
}

async function showDictationWindow() {
  previousAppName = await getPreviousApp();
  console.log("Предыдущее приложение:", previousAppName);

  if (!mainWindow) {
    createMainWindow();
  }

  const { screen } = require("electron");
  const display = screen.getPrimaryDisplay();
  const { width, height } = display.workAreaSize;

  const windowWidth = 440;
  const windowHeight = 380;
  const x = Math.floor((width - windowWidth) / 2);
  const y = Math.floor((height - windowHeight) / 2);

  mainWindow.setPosition(x, y);
  mainWindow.show();
  mainWindow.focus();

  setTimeout(() => {
    mainWindow.webContents.send("auto-start-recording");
  }, 100);
}

async function checkAccessibilityPermissions() {
  try {
    // await execAsync(
    //   'osascript -e \'tell application "System Events" to keystroke "test"\''
    // );
    console.log("✓ Разрешения Accessibility: ВКЛЮЧЕНЫ");
    return true;
  } catch (error) {
    console.log("✗ Разрешения Accessibility: ОТКЛЮЧЕНЫ");
    console.log("");
    console.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
    console.log("⚠️  ТРЕБУЕТСЯ НАСТРОЙКА РАЗРЕШЕНИЙ");
    console.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
    console.log("");
    console.log("Для автоматической вставки текста:");
    console.log("");
    console.log("1. Откройте Системные настройки");
    console.log("2. → Конфиденциальность и безопасность");
    console.log("3. → Специальные возможности (Accessibility)");
    console.log("4. Нажмите замок 🔒 и введите пароль");
    console.log("5. Добавьте Electron в список (кнопка +)");
    console.log("6. Включите галочку ✓");
    console.log("");
    console.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
    console.log("");
    return false;
  }
}

app.whenReady().then(async () => {
  createMainWindow();

  console.log("🎤 Приложение для диктовки запущено");
  console.log("Горячая клавиша: ⌘ + Shift + D");
  console.log("");

  await checkAccessibilityPermissions();

  createTray();

  const ret = globalShortcut.register("CommandOrControl+Shift+D", () => {
    if (mainWindow && mainWindow.isVisible()) {
      mainWindow.webContents.send("toggle-recording");
    } else {
      showDictationWindow();
    }
  });

  if (!ret) {
    console.log("Не удалось зарегистрировать горячую клавишу");
  }

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createMainWindow();
    }
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") {
    app.quit();
  }
});

app.on("will-quit", () => {
  globalShortcut.unregisterAll();
});

ipcMain.on("hide-window", () => {
  if (mainWindow) {
    mainWindow.hide();
  }
});

ipcMain.on("debug-log", (event, ...args) => {
  try {
    console.log(...args);
  } catch (_) {}
});

ipcMain.on("open-settings", () => {
  createSettingsWindow();
});

ipcMain.on("save-settings", (event, settings) => {
  store.set("apiKey", settings.apiKey);
  store.set("googleApiKey", settings.googleApiKey || "");
  store.set("aiProvider", settings.aiProvider || "openai");
  store.set("language", settings.language || "ru");
  if (settingsWindow) {
    settingsWindow.close();
  }
});

ipcMain.on("get-settings", (event) => {
  event.returnValue = {
    apiKey: store.get("apiKey", ""),
    googleApiKey: store.get("googleApiKey", ""),
    aiProvider: store.get("aiProvider", "openai"),
    language: store.get("language", "ru"),
    pasteMethod: store.get("pasteMethod", "clipboard"),
  };
});

ipcMain.on("save-paste-method", (event, method) => {
  store.set("pasteMethod", method);
  console.log("Метод вставки изменён на:", method);
});

ipcMain.handle("should-hide-window", () => {
  return !settingsWindow || settingsWindow.isDestroyed();
});

ipcMain.on("set-prevent-hide", (event, prevent) => {
  preventAutoHide = prevent;
});

ipcMain.on("paste-text", async (event, text) => {
  console.log("=== Начало вставки текста ===");
  console.log("Длина текста:", text.length);
  console.log("Первые 50 символов:", text.substring(0, 50));

  if (mainWindow) {
    mainWindow.hide();
  }

  (async () => {
    try {
      const previousClipboard = clipboard.readText();
      console.log("Сохранён предыдущий буфер обмена");

      clipboard.writeText(text);
      console.log("Текст скопирован в буфер обмена");

      if (process.platform === "darwin") {
        if (previousAppName && previousAppName !== "Electron") {
          console.log("Возвращаем фокус на:", previousAppName);
          await activateApp(previousAppName);
          await new Promise((resolve) => setTimeout(resolve, 100));
          console.log("Фокус возвращён");
        }

        const settings = store.get("pasteMethod", "clipboard");
        let success = false;

        try {
          if (settings === "direct") {
            console.log("Используем прямой ввод текста...");
            success = await typeTextDirectly(text);
            if (success) {
              console.log("✓ Текст введён напрямую!");
            }
          } else {
            console.log("Проверяем буфер обмена перед вставкой...");
            const clipboardCheck = clipboard.readText();
            console.log("В буфере:", clipboardCheck.substring(0, 30) + "...");

            console.log("Пытаемся вставить через меню приложения...");

            try {
              const appName = previousAppName;
              const script = `osascript -e 'tell application "System Events" to tell process "${appName}" to try\n  click menu item "Paste" of menu "Edit" of menu bar 1\nend try'`;
              await execAsync(script);
              console.log("✓ Пункт меню Paste нажат");
              success = true;
            } catch (e1) {
              try {
                const appName = previousAppName;
                const scriptRu = `osascript -e 'tell application "System Events" to tell process "${appName}" to try\n  click menu item "Вставить" of menu "Правка" of menu bar 1\nend try'`;
                await execAsync(scriptRu);
                console.log("✓ Пункт меню Вставить нажат");
                success = true;
              } catch (e2) {
                console.log("Меню недоступно, выполняем Cmd+V...");
                await execAsync(
                  "osascript -e 'tell application \"System Events\" to key code 9 using {command down}'"
                );
                console.log("✓ Команда Cmd+V выполнена!");
                success = true;
              }
            }
          }

          setTimeout(() => {
            clipboard.writeText(previousClipboard);
            console.log("Буфер обмена восстановлен");
          }, 150);

          if (!success) {
            throw new Error("Не удалось вставить текст");
          }
        } catch (error) {
          console.error("✗ Ошибка вставки текста:", error.message);
          console.log("💡 Попробуйте изменить метод вставки в настройках");

          if (mainWindow) {
            mainWindow.webContents.send("paste-error", {
              message: "Не удалось вставить текст автоматически",
              text: text,
            });
            mainWindow.show();
          }

          clipboard.writeText(previousClipboard);
        }
      }
    } catch (error) {
      console.error("Критическая ошибка:", error);
    }
  })();
});
