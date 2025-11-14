const { ipcRenderer } = require("electron");
const OpenAI = require("openai");
const {
  GoogleGenAI,
  createUserContent,
  createPartFromUri,
} = require("@google/genai");
const fs = require("fs");
const path = require("path");
const os = require("os");

let mediaRecorder = null;
let audioChunks = [];
let recordingStartTime = null;
let timerInterval = null;
let openai = null;
let googleAI = null;
let abortController = null;

const recordBtn = document.getElementById("recordBtn");
const cancelBtn = document.getElementById("cancelBtn");
const closeBtn = document.getElementById("closeBtn");
const settingsBtn = document.getElementById("settingsBtn");
const statusEl = document.getElementById("status");
const timerEl = document.getElementById("timer");
const resultEl = document.getElementById("result");

let isRecording = false;
let isProcessing = false;
let userCanceled = false;

const MAX_RETRIES = 3;
const INITIAL_BACKOFF_MS = 1000;

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function delayWithAbort(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal && signal.aborted) {
      reject(new Error("Запрос отменён пользователем"));
      return;
    }
    const timerId = setTimeout(() => {
      if (signal) {
        signal.removeEventListener("abort", onAbort);
      }
      resolve();
    }, ms);
    function onAbort() {
      clearTimeout(timerId);
      reject(new Error("Запрос отменён пользователем"));
    }
    if (signal) {
      signal.addEventListener("abort", onAbort, { once: true });
    }
  });
}

function withAbort(promise) {
  if (!abortController) return promise;
  const signal = abortController.signal;
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      const onAbort = () => reject(new Error("Запрос отменён пользователем"));
      if (signal.aborted) {
        onAbort();
      } else {
        signal.addEventListener("abort", onAbort, { once: true });
      }
    }),
  ]);
}

function getHttpStatus(error) {
  if (typeof error?.status === "number") return error.status;
  if (typeof error?.code === "number") return error.code;
  if (typeof error?.response?.status === "number") return error.response.status;
  return undefined;
}

function isRetryable(error) {
  const status = getHttpStatus(error);
  if (status && status >= 500 && status <= 599) return true;
  const msg = (error?.message || "").toLowerCase();
  if (msg.includes("timeout") || msg.includes("timed out")) return true;
  if (msg.includes("econnreset") || msg.includes("network")) return true;
  return false;
}

async function transcribeWithRetries(tempFilePath, provider) {
  let attempt = 0;
  let lastError = null;
  while (attempt < MAX_RETRIES) {
    if (abortController && abortController.signal.aborted) {
      throw new Error("Запрос отменён пользователем");
    }
    try {
      if (provider === "google") {
        const uploaded = await withAbort(
          googleAI.files.upload({
            file: tempFilePath,
            config: { mimeType: "audio/webm" },
          })
        );
        if (abortController && abortController.signal.aborted) {
          throw new Error("Запрос отменён пользователем");
        }
        const result = await withAbort(
          googleAI.models.generateContent({
            model: "gemini-2.5-flash",
            contents: createUserContent([
              createPartFromUri(uploaded.uri, uploaded.mimeType),
              `Generate a transcript of the speech. Output only the transcript text without any additional formatting or explanation. Remove disfluencies and filler words.`,
            ]),
          })
        );
        let text = "";
        try {
          const plainText =
            result && typeof result.text === "string" ? result.text : undefined;
          if (plainText && plainText.trim()) {
            text = plainText;
          } else {
            const response = result.response;
            const candidates = response?.candidates;
            if (candidates && candidates.length > 0) {
              const content = candidates[0].content;
              const parts = content?.parts;
              if (parts && parts.length > 0) {
                text = parts.map((part) => part.text).join("");
              }
            }
          }
        } catch (_) {}
        ipcRenderer.send("debug-log", "Извлечённый текст от Google", text);
        return text;
      } else {
        const result = await openai.audio.transcriptions.create(
          {
            file: fs.createReadStream(tempFilePath),
            model: "gpt-4o-transcribe",
            response_format: "text",
          },
          { signal: abortController ? abortController.signal : undefined }
        );
        return result;
      }
    } catch (error) {
      if (abortController && abortController.signal.aborted) {
        throw new Error("Запрос отменён пользователем");
      }
      lastError = error;
      if (!isRetryable(error) || attempt === MAX_RETRIES - 1) {
        throw error;
      }
      const next = attempt + 1;
      const backoff = INITIAL_BACKOFF_MS * Math.pow(2, attempt);
      const status = getHttpStatus(error);
      const statusHint = status ? ` (${status})` : "";
      statusEl.textContent = `Ошибка${statusHint}. Повтор ${
        next + 1
      }/${MAX_RETRIES} через ${Math.round(backoff / 1000)} с...`;
      await delayWithAbort(
        backoff,
        abortController ? abortController.signal : undefined
      );
      attempt++;
    }
  }
  throw lastError || new Error("Неизвестная ошибка");
}

function initAI() {
  const settings = ipcRenderer.sendSync("get-settings");
  const provider = settings.aiProvider || "openai";

  if (provider === "google") {
    if (settings.googleApiKey) {
      googleAI = new GoogleGenAI({ apiKey: settings.googleApiKey });
      return true;
    }
    return false;
  } else {
    if (settings.apiKey) {
      openai = new OpenAI({
        apiKey: settings.apiKey,
        dangerouslyAllowBrowser: true,
      });
      return true;
    }
    return false;
  }
}

function formatTime(seconds) {
  const mins = Math.floor(seconds / 60);
  const secs = seconds % 60;
  return `${mins}:${secs.toString().padStart(2, "0")}`;
}

function startTimer() {
  recordingStartTime = Date.now();
  timerInterval = setInterval(() => {
    const elapsed = Math.floor((Date.now() - recordingStartTime) / 1000);
    timerEl.textContent = formatTime(elapsed);
  }, 1000);
}

function stopTimer() {
  if (timerInterval) {
    clearInterval(timerInterval);
    timerInterval = null;
  }
  timerEl.textContent = "0:00";
}

async function startRecording() {
  if (!initAI()) {
    const settings = ipcRenderer.sendSync("get-settings");
    const provider = settings.aiProvider || "openai";
    ipcRenderer.send("debug-log", "provider", provider);
    const providerName = provider === "google" ? "Google" : "OpenAI";
    statusEl.textContent = `Ошибка: не настроен API ключ ${providerName}`;
    statusEl.classList.add("error");
    setTimeout(() => {
      ipcRenderer.send("open-settings");
    }, 1500);
    return;
  }

  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });

    mediaRecorder = new MediaRecorder(stream, {
      mimeType: "audio/webm",
    });

    audioChunks = [];
    userCanceled = false;

    mediaRecorder.addEventListener("dataavailable", (event) => {
      audioChunks.push(event.data);
    });

    mediaRecorder.addEventListener("stop", async () => {
      stream.getTracks().forEach((track) => track.stop());
      await processRecording();
    });

    mediaRecorder.start();
    isRecording = true;

    recordBtn.classList.add("recording");
    statusEl.textContent = "Идёт запись... Нажмите ещё раз для завершения";
    statusEl.classList.remove("error");

    startTimer();
  } catch (error) {
    console.error("Ошибка доступа к микрофону:", error);
    statusEl.textContent = "Ошибка: нет доступа к микрофону";
    statusEl.classList.add("error");
  }
}

function stopRecording() {
  if (mediaRecorder && mediaRecorder.state !== "inactive") {
    mediaRecorder.stop();
    isRecording = false;
    recordBtn.classList.remove("recording");
    stopTimer();
  }
}

async function processRecording() {
  if (userCanceled) {
    return;
  }
  isProcessing = true;
  ipcRenderer.send("set-prevent-hide", true);
  recordBtn.classList.add("processing");
  recordBtn.querySelector(".mic-icon").textContent = "⏹️";
  statusEl.textContent = "Обработка аудио...";
  resultEl.textContent = "";

  abortController = new AbortController();

  try {
    let tempFilePath = null;
    const audioBlob = new Blob(audioChunks, { type: "audio/webm" });

    const tempDir = os.tmpdir();
    const tempFileName = `dictation_${Date.now()}.webm`;
    tempFilePath = path.join(tempDir, tempFileName);

    const arrayBuffer = await audioBlob.arrayBuffer();
    const buffer = Buffer.from(arrayBuffer);
    fs.writeFileSync(tempFilePath, buffer);

    statusEl.textContent = "Распознавание речи...";

    const settings = ipcRenderer.sendSync("get-settings");
    const provider = settings.aiProvider || "openai";
    const language = settings.language || "ru";

    let transcription = "";

    if (abortController.signal.aborted) {
      throw new Error("Запрос отменён пользователем");
    }

    transcription = await transcribeWithRetries(tempFilePath, provider);

    if (abortController.signal.aborted) {
      throw new Error("Запрос отменён пользователем");
    }

    if (transcription && transcription.trim()) {
      statusEl.textContent = "Вставка текста...";

      ipcRenderer.send("paste-text", transcription);

      const shouldHide = await ipcRenderer.invoke("should-hide-window");

      statusEl.textContent = "Нажмите на микрофон для начала";
      statusEl.classList.remove("error");
      resultEl.textContent = "";

      setTimeout(() => {
        ipcRenderer.send("set-prevent-hide", false);
        if (shouldHide) {
          ipcRenderer.send("hide-window");
        }
        resetUI();
      }, 500);
    } else {
      statusEl.textContent = "Речь не распознана";
      statusEl.classList.add("error");
      resetUI();
    }
  } catch (error) {
    console.error("Ошибка обработки:", error);

    const isAborted = error.message.includes("отменён");

    if (isAborted) {
      statusEl.textContent = "Запрос отменён";
      statusEl.classList.add("error");

      setTimeout(() => {
        statusEl.textContent = "Нажмите на микрофон для начала";
        statusEl.classList.remove("error");
        resultEl.textContent = "";
      }, 2000);
    } else {
      const status = getHttpStatus(error);
      const suffix = status ? ` (${status})` : "";
      statusEl.textContent = "Ошибка: " + error.message + suffix;
      statusEl.classList.add("error");
      resetUI();
    }
  } finally {
    try {
      const tmp = typeof tempFilePath === "string" ? tempFilePath : null;
      if (tmp && fs.existsSync(tmp)) {
        fs.unlinkSync(tmp);
      }
    } catch (_) {}
    abortController = null;
    isProcessing = false;
    ipcRenderer.send("set-prevent-hide", false);
    recordBtn.classList.remove("processing");
    recordBtn.querySelector(".mic-icon").textContent = "🎤";
  }
}

function resetUI() {
  setTimeout(() => {
    statusEl.textContent = "Нажмите на микрофон для начала";
    statusEl.classList.remove("error");
    resultEl.textContent = "";
  }, 2000);
}

recordBtn.addEventListener("click", () => {
  if (isProcessing) {
    if (abortController) {
      console.log("Отмена запроса пользователем");
      abortController.abort();
      statusEl.textContent = "Отмена запроса...";
    }
    return;
  }

  if (isRecording) {
    stopRecording();
  } else {
    startRecording();
  }
});

cancelBtn.addEventListener("click", () => {
  userCanceled = true;
  if (isProcessing && abortController) {
    console.log("Отмена через кнопку Отмена");
    abortController.abort();
    ipcRenderer.send("hide-window");
    return;
  }

  if (isRecording) {
    stopRecording();
    audioChunks = [];
  }

  resetUI();
  ipcRenderer.send("hide-window");
});

settingsBtn.addEventListener("click", () => {
  ipcRenderer.send("open-settings");
});

closeBtn.addEventListener("click", () => {
  ipcRenderer.send("hide-window");
});

document.addEventListener("keydown", (e) => {
  if (e.key === "Escape") {
    if (isRecording) {
      stopRecording();
      audioChunks = [];
      resetUI();
    }
    ipcRenderer.send("hide-window");
  }
});

ipcRenderer.on("paste-error", (event, data) => {
  statusEl.innerHTML = `${data.message}<br><small>Текст скопирован в буфер обмена. Настройте разрешения в Системных настройках.</small>`;
  statusEl.classList.add("error");
  resultEl.textContent = data.text;
});

ipcRenderer.on("auto-start-recording", () => {
  if (!isRecording && !isProcessing) {
    startRecording();
  }
});

ipcRenderer.on("toggle-recording", () => {
  if (isProcessing) return;

  if (isRecording) {
    stopRecording();
  } else {
    startRecording();
  }
});
