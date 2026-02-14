/* global chrome */
console.log("[JobSnap] content script loaded:", location.href);

function showToast(msg) {
  try {
    const id = "jobmatch-toast";
    let el = document.getElementById(id);

    if (!el) {
      el = document.createElement("div");
      el.id = id;
      el.style.position = "fixed";
      el.style.bottom = "16px";
      el.style.right = "16px";
      el.style.zIndex = "2147483647";
      el.style.padding = "10px 12px";
      el.style.borderRadius = "12px";
      el.style.background = "rgba(0,0,0,0.72)";
      el.style.color = "#fff";
      el.style.fontSize = "12px";
      el.style.border = "1px solid rgba(255,255,255,0.15)";
      el.style.maxWidth = "320px";
      el.style.boxShadow = "0 8px 24px rgba(0,0,0,0.35)";
      document.documentElement.appendChild(el);
    }

    el.textContent = msg;

    clearTimeout(el.__t);
    el.__t = setTimeout(() => {
      el?.remove?.();
    }, 1600);
  } catch {
    // ignore
  }
}

function storageGet(area, key) {
  return new Promise((resolve) => {
    chrome.storage[area].get([key], (res) => resolve(res || {}));
  });
}

function sendMessage(message) {
  return new Promise((resolve) => {
    chrome.runtime.sendMessage(message, (resp) => resolve(resp));
  });
}

function storeLatestJob(latestJob) {
  return new Promise((resolve) => {
    chrome.storage.session.set({ latestJob }, () => resolve(true));
  });
}

function cleanText(t) {
  return String(t || "")
    .replace(/\u00a0/g, " ")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/* -------------------- JD extraction helpers (ACTIVE) -------------------- */

function findLikelyJDText() {
  const selectors = [
    // common job boards / patterns
    '[data-test="jobDescriptionText"]',
    '[data-testid="jobDescriptionText"]',
    ".job-description",
    "#job-description",
    "article",
    "main",
  ];

  for (const sel of selectors) {
    const el = document.querySelector(sel);
    if (el && el.innerText && el.innerText.trim().length > 300) {
      return el.innerText;
    }
  }

  // fallback: body (trimmed)
  return document.body?.innerText || "";
}

// ✅ ADDED (so your new triple-click flow can call cleanJD)
function cleanJD(t) {
  return cleanText(t);
}

// ✅ ADDED (so your new triple-click flow can call extractJobDescriptionText)
function extractJobDescriptionText() {
  // Prefer user selection (triple-click often selects a paragraph)
  const sel = window.getSelection?.();
  const selected = sel?.toString?.() || "";
  if (selected.trim().length >= 200) return selected;

  // Fallback to your heuristic finder
  return findLikelyJDText();
}

function captureJD() {
  // prefer user selection (triple-click usually selects a block/paragraph)
  const sel = window.getSelection();
  const selected = sel?.toString() || "";
  const candidate = selected.trim().length >= 200 ? selected : findLikelyJDText();
  const text = cleanText(candidate).slice(0, 18000);
  return text;
}

async function sendCaptured(job_text) {
  if (!job_text || job_text.length < 200) return;
  chrome.runtime.sendMessage({ type: "JOB_CAPTURED", job_text });
}

// triple-click detection: click event has .detail count
// document.addEventListener("click", async (e) => {
//   try {
//     if (e.detail === 3) {
//       const jd = captureJD();
//       await sendCaptured(jd);
//     }
//   } catch {
//     // ignore
//   }
// });

// Put this near your other listeners (keep capture=true)
document.addEventListener(
  "click",
  async (e) => {
    try {
      // Chrome provides click count in event.detail
      if (e.detail !== 3) return;

      // (Optional) only skip inputs/textarea; some pages mark divs as contenteditable
      const tag = e.target?.tagName?.toLowerCase();
      if (tag === "input" || tag === "textarea") return;

      const jobTextRaw = extractJobDescriptionText();
      const jobText = cleanJD(jobTextRaw);

      if (!jobText || jobText.length < 250) {
        showToast("JD not found on this page ❌");
        return;
      }

      const MAX_CHARS = 20000;
      const trimmed =
        jobText.length <= MAX_CHARS
          ? jobText
          : jobText.slice(0, 12000) + "\n\n...[TRIMMED]...\n\n" + jobText.slice(-7000);

      showToast("JD captured ✅ Analyzing...");

      const latestJob = {
        savedAt: new Date().toISOString(),
        url: location.href,
        title: document.title || "",
        jobText: trimmed,
      };

      await storeLatestJob(latestJob);

      const { resumeText = "" } = await storageGet("local", "resumeText");
      if (!resumeText.trim()) {
        showToast("Open extension → paste resume → Save Resume.");
        return;
      }

      const resp = await sendMessage({
        type: "AUTO_ANALYZE",
        jobText,
        payload: {
          // resume_text: resumeText.trim(),
          job_text: latestJob.jobText,
          job_url: latestJob.url,
          job_title: latestJob.title,
        },
      });

      if (!resp?.ok) {
        showToast("Analysis failed ❌ (check backend)");
        return;
      }

      const percent = resp?.result?.p ?? 0;
      showToast(`Done ✅ Match: ${percent}%`);
    } catch (err) {
      console.error(err);
      showToast("Error ❌ (check console)");
    }
  },
  true
);

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  (async () => {
    if (msg?.type === "CAPTURE_NOW") {
      const jd = captureJD();
      sendResponse({ job_text: jd });
      // also trigger analysis pipeline
      await sendCaptured(jd);
      return;
    }
    if (msg?.type === "GET_PAGE_TEXT") {
      sendResponse({ text: cleanText(document.body?.innerText || "").slice(0, 18000) });
      return;
    }
    sendResponse({ ok: false });
  })();
  return true;
});

// ------ old function 
/* -------------------------- small promise helpers -------------------------- */
// function sendMessage(msg) {
//   return new Promise((resolve, reject) => {
//     try {
//       chrome.runtime.sendMessage(msg, (resp) => {
//         const err = chrome.runtime.lastError;
//         if (err) return reject(new Error(err.message || String(err)));
//         resolve(resp);
//       });
//     } catch (e) {
//       reject(e);
//     }
//   });
// }

// function storageGet(area, key) {
//   return new Promise((resolve, reject) => {
//     try {
//       chrome.storage[area].get(key, (data) => {
//         const err = chrome.runtime.lastError;
//         if (err) return reject(new Error(err.message || String(err)));
//         resolve(data);
//       });
//     } catch (e) {
//       reject(e);
//     }
//   });
// }

// function storageSet(area, obj) {
//   return new Promise((resolve, reject) => {
//     try {
//       chrome.storage[area].set(obj, () => {
//         const err = chrome.runtime.lastError;
//         if (err) return reject(new Error(err.message || String(err)));
//         resolve();
//       });
//     } catch (e) {
//       reject(e);
//     }
//   });
// }

// function hasSessionStorage() {
//   return !!chrome?.storage?.session && typeof chrome.storage.session.set === "function";
// }

// /* ------------------------------- UI helpers -------------------------------- */
// function showToast(msg) {
//   const toast = document.createElement("div");
//   toast.textContent = msg;
//   toast.style.position = "fixed";
//   toast.style.bottom = "16px";
//   toast.style.right = "16px";
//   toast.style.zIndex = "999999";
//   toast.style.padding = "8px 10px";
//   toast.style.borderRadius = "10px";
//   toast.style.background = "black";
//   toast.style.color = "white";
//   toast.style.fontSize = "12px";
//   toast.style.opacity = "0.92";
//   document.documentElement.appendChild(toast);
//   setTimeout(() => toast.remove(), 1600);
// }

// function isEditableTarget(el) {
//   if (!el) return false;
//   const tag = el.tagName?.toLowerCase();
//   return tag === "input" || tag === "textarea" || el.isContentEditable === true;
// }

// /* ------------------------------ text helpers -------------------------------- */
// function normalizeText(t) {
//   return String(t || "")
//     .replace(/\r/g, "")
//     .replace(/[ \t]+\n/g, "\n")
//     .replace(/\n{3,}/g, "\n\n")
//     .trim();
// }

// function getText(el) {
//   return normalizeText(el?.innerText || el?.textContent || "");
// }

// function getHostname() {
//   try {
//     return location.hostname.toLowerCase();
//   } catch {
//     return "";
//   }
// }

// function visible(el) {
//   if (!el) return false;
//   const style = window.getComputedStyle(el);
//   if (style.display === "none" || style.visibility === "hidden" || style.opacity === "0") return false;
//   const r = el.getBoundingClientRect();
//   return r.width > 0 && r.height > 0;
// }

// function isProbablyNotContent(el) {
//   const tag = el.tagName?.toLowerCase();
//   if (!tag) return true;
//   if (["nav", "header", "footer", "aside", "script", "style", "noscript"].includes(tag)) return true;

//   const cls = (el.className || "").toString().toLowerCase();
//   const id = (el.id || "").toString().toLowerCase();
//   const bad = ["nav", "menu", "footer", "header", "sidebar", "cookie", "banner", "modal", "popup", "ads", "advert", "subscribe"];
//   if (bad.some((b) => cls.includes(b) || id.includes(b))) return true;

//   return false;
// }

// /* -------------------------- job description extract ------------------------- */
// function extractBySiteSelectors() {
//   const host = getHostname();

//   const selectorsBySite = [
//     {
//       match: /linkedin\.com$/,
//       selectors: [
//         ".jobs-description__content",
//         ".jobs-box__html-content",
//         ".jobs-description-content__text",
//         "section[class*='description']",
//         "div[class*='description']",
//       ],
//     },
//     {
//       match: /naukri\.com$/,
//       selectors: [
//         ".job-desc",
//         ".dang-inner-html",
//         "section[class*='job-desc']",
//         "div[class*='job-desc']",
//         "div[class*='JobDescription']",
//       ],
//     },
//     {
//       match: /indeed\./,
//       selectors: [
//         "#jobDescriptionText",
//         "div[id*='jobDescriptionText']",
//         "div[class*='jobsearch-JobComponent-description']",
//         "section[class*='description']",
//       ],
//     },
//   ];

//   const site = selectorsBySite.find((s) => s.match.test(host));
//   if (!site) return null;

//   for (const sel of site.selectors) {
//     const el = document.querySelector(sel);
//     if (el && visible(el)) {
//       const txt = getText(el);
//       if (txt.length > 200) return txt;
//     }
//   }
//   return null;
// }

// function extractByHeuristic() {
//   const candidates = Array.from(document.querySelectorAll("main, article, section, div"))
//     .filter((el) => el && visible(el) && !isProbablyNotContent(el));

//   const jobKeywords = [
//     "responsibilities",
//     "requirements",
//     "qualification",
//     "skills",
//     "experience",
//     "job description",
//     "must have",
//     "nice to have",
//     "preferred",
//     "benefits",
//     "location",
//     "salary",
//   ];

//   function score(el) {
//     const text = getText(el);
//     const len = text.length;
//     if (len < 400) return -Infinity;

//     const links = el.querySelectorAll("a").length || 0;
//     const density = len / (links + 1);

//     const lower = text.toLowerCase();
//     let kw = 0;
//     for (const k of jobKeywords) if (lower.includes(k)) kw += 1;

//     const controls = el.querySelectorAll("button, input, textarea, select").length;
//     const interactPenalty = controls > 10 ? 2000 : controls * 30;

//     return density + kw * 800 - interactPenalty;
//   }

//   let best = null;
//   let bestScore = -Infinity;

//   for (const el of candidates.slice(0, 300)) {
//     const s = score(el);
//     if (s > bestScore) {
//       bestScore = s;
//       best = el;
//     }
//   }
//   if (!best) return null;

//   let textBest = getText(best);

//   // If too huge, try best child
//   if (textBest.length > 25000) {
//     const kids = Array.from(best.querySelectorAll("section, div"))
//       .filter((el) => el && visible(el) && !isProbablyNotContent(el));

//     let kb = null, kbs = -Infinity;
//     for (const el of kids.slice(0, 300)) {
//       const s = score(el);
//       if (s > kbs) {
//         kbs = s;
//         kb = el;
//       }
//     }
//     if (kb) textBest = getText(kb);
//   }

//   return textBest;
// }

// function cleanJD(text) {
//   let t = normalizeText(text);

//   const lines = t.split("\n").map((l) => l.trim());
//   const kept = lines.filter((l) => l.length >= 3);
//   t = kept.join("\n");

//   t = t.replace(/[ \t]{2,}/g, " ").trim();
//   return t;
// }

// function extractJobDescriptionText() {
//   const siteText = extractBySiteSelectors();
//   if (siteText) return siteText;

//   const heuristicText = extractByHeuristic();
//   if (heuristicText && heuristicText.length > 300) return heuristicText;

//   return normalizeText(document.body?.innerText || "");
// }

// /* ------------------------------ clipboard copy ------------------------------ */
// async function copyToClipboard(text) {
//   // Best: navigator.clipboard (works on many sites with user gesture)
//   try {
//     if (navigator?.clipboard?.writeText) {
//       await navigator.clipboard.writeText(text);
//       return true;
//     }
//   } catch (e) {
//     console.warn("Clipboard API failed:", e);
//   }

//   // Fallback: execCommand copy
//   try {
//     const ta = document.createElement("textarea");
//     ta.value = text;
//     ta.style.position = "fixed";
//     ta.style.left = "-9999px";
//     ta.style.top = "0";
//     document.body.appendChild(ta);
//     ta.focus();
//     ta.select();
//     const ok = document.execCommand("copy");
//     ta.remove();
//     return ok;
//   } catch (e) {
//     console.warn("execCommand copy failed:", e);
//     return false;
//   }
// }

// /* ------------------------------ tab + storage ------------------------------ */
// async function storeLatestJob(latestJob) {
//   // Prefer background storage (tabId comes from sender.tab.id)
//   try {
//     const resp = await sendMessage({ type: "STORE_LATEST_JOB", payload: latestJob });
//     if (resp?.ok) return { ok: true, method: "STORE_LATEST_JOB" };
//   } catch (e) {
//     // ignore: maybe handler not implemented
//   }

//   // Fallback: ask tabId, store directly
//   const tabResp = await sendMessage({ type: "GET_TAB_ID" });
//   const tabId = tabResp?.tabId ?? null;
//   if (tabId == null) return { ok: false, error: "TabId not found" };

//   const key = `latestJob_tab_${tabId}`;
//   const area = hasSessionStorage() ? "session" : "local";
//   await storageSet(area, { [key]: latestJob });
//   return { ok: true, method: `storage.${area}` };
// }

// /* -------------------------- triple-click capture flow ----------------------- */
// let clickCount = 0;
// let lastClickTime = 0;
// let cooldownUntil = 0;

// // easier than 700ms
// const CLICK_WINDOW_MS = 1200;
// const COOLDOWN_MS = 2500;

// document.addEventListener(
//   "pointerdown",
//   async (e) => {
//     if (isEditableTarget(e.target)) return;

//     const now = Date.now();
//     if (now < cooldownUntil) return;

//     if (now - lastClickTime > CLICK_WINDOW_MS) clickCount = 0;
//     clickCount += 1;
//     lastClickTime = now;

//     if (clickCount !== 3) return;

//     clickCount = 0;
//     cooldownUntil = now + COOLDOWN_MS;

//     try {
//       const jobTextRaw = extractJobDescriptionText();
//       const jobText = cleanJD(jobTextRaw);

//       if (!jobText || jobText.length < 250) {
//         showToast("JD not found on this page ❌");
//         return;
//       }

//       // Trim huge text (token + speed)
//       const MAX_CHARS = 20000;
//       const trimmed =
//         jobText.length <= MAX_CHARS
//           ? jobText
//           : jobText.slice(0, 12000) + "\n\n...[TRIMMED]...\n\n" + jobText.slice(-7000);

//       // ✅ copy JD to clipboard
//       const copied = await copyToClipboard(trimmed);
//       showToast(copied ? "JD copied ✅ Capturing..." : "Captured (copy failed) ⚠️");

//       const latestJob = {
//         savedAt: new Date().toISOString(),
//         url: location.href,
//         title: document.title || "",
//         jobText: trimmed,
//       };

//       // ✅ store latest job (per tab)
//       const stored = await storeLatestJob(latestJob);
//       if (!stored.ok) {
//         showToast("Store failed ❌ (check console)");
//         console.error("Store failed:", stored.error);
//         return;
//       }

//       showToast("JD captured ✅ Analyzing...");

//       // resume from sync (user saves once in popup)
//       const { resumeText = "" } = await storageGet("sync", "resumeText");
//       if (!resumeText.trim()) {
//         showToast("Open extension → paste resume → Save Resume.");
//         return;
//       }

//       // trigger background analysis (your existing background listener)
//       const resp = await sendMessage({
//         type: "AUTO_ANALYZE",
//         payload: {
//           resume_text: resumeText.trim(),
//           job_text: latestJob.jobText,
//           job_url: latestJob.url,
//           job_title: latestJob.title,
//         },
//       });

//       if (!resp?.ok) {
//         showToast("Analysis failed ❌ (check backend)");
//         return;
//       }

//       const percent = resp?.result?.p ?? 0;
//       showToast(`Done ✅ Match: ${percent}%`);
//     } catch (err) {
//       console.error(err);
//       showToast("Error ❌ (check console)");
//     }
//   },
//   true
// ); "do not remove my comment code"
