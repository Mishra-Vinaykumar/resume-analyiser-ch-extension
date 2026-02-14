/* global chrome */

// const BACKEND_URL = "http://localhost:3000/match-resume";
const BACKEND_URL = "https://resume-analyser-backend-7132.onrender.com/";

const RESUME_KEY = (tabId) => `jobmatch:resume:${tabId}`;
const JOB_KEY = (tabId) => `jobmatch:job:${tabId}`;
const ANALYSIS_KEY = (tabId) => `jobmatch:analysis:${tabId}`;

async function getActiveTab() {
  const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
  return tabs?.[0] || null;
}

async function setBadge(tabId, percent) {
  const text = typeof percent === "number" ? String(Math.max(0, Math.min(100, percent))) : "";
  await chrome.action.setBadgeText({ tabId, text });
  await chrome.action.setBadgeBackgroundColor({ tabId, color: "#1a73e8" });
}

async function notify(title, message) {
  try {
    await chrome.notifications.create({
      type: "basic",
      // iconUrl: "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4//8/AwAI/AL+X2y9VQAAAABJRU5ErkJggg==",
      title,
      message,
    });
  } catch {
    // ignore if notifications fail
  }
}

async function readResumeText(tabId) {
  if (!tabId) return "";

  const key = RESUME_KEY(tabId);
  const data = await chrome.storage.local.get({ [key]: "" });
  return String(data?.[key] || "").trim();
}


async function readJobForTab(tabId) {
  const key = JOB_KEY(tabId);
  const data = await chrome.storage.session.get(key);
  return data?.[key] || null;
}

async function saveJobForTab(tabId, job) {
  await chrome.storage.session.set({ [JOB_KEY(tabId)]: job });
}

async function saveAnalysisForTab(tabId, result, meta = {}) {
  await chrome.storage.session.set({
    [ANALYSIS_KEY(tabId)]: {
      ...result, // expects {p, report, json, ...}
      analyzedAt: new Date().toISOString(),
      ...meta,
    },
  });
}

async function callBackend({ resume_text, job_text, job_url, job_title }) {
  const r = await fetch(BACKEND_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ resume_text, job_text, job_url, job_title }),
  });

  const data = await r.json();
  return data;
}

/**
 * Analyze a tab.
 * - If payloadOverride is provided, it uses that data (used for AUTO_ANALYZE from content.js).
 * - Otherwise uses stored job + CAPTURE_NOW fallback.
 * Returns the backend result object.
 */
async function analyzeTab(tabId, payloadOverride = null) {
  // 1) Resume
  const resume_text = await readResumeText(tabId);

  // const resume_text = payloadOverride?.resume_text
  //   ? String(payloadOverride.resume_text).trim()
  //   : await readResumeText(tabId);

  if (!resume_text) {
    await setBadge(tabId, 0);
    const result = {
      p: 0,
      report:
        'REPORT (conversational analysis):\n"""\nPlease paste your resume (Skills/Summary/Experience) in the popup first.\n"""',
      json: {
        status: "ELIGIBLE",
        blocker_type: null,
        blocker_text: null,
        eligible_for_opt: true,
        match_score: 0,
        recommendation: "BORDERLINE",
        requirements: [],
      },
    };
    await saveAnalysisForTab(tabId, result);
    return result;
  }

  // 2) Job text
  let job = null;

  // If content.js sends full payload, use it.
  if (payloadOverride?.job_text) {
    const job_url = String(payloadOverride?.job_url || "");
    const job_title = String(payloadOverride?.job_title || "");

    job = {
      job_text: String(payloadOverride.job_text || ""),
      job_url,
      job_title,
      capturedAt: new Date().toISOString(),
    };

    await saveJobForTab(tabId, job);
  } else {
    // fallback to stored tab job
    job = await readJobForTab(tabId);
  }

  // If still no job, ask content script to capture now
  if (!job?.job_text) {
    try {
      const tab = await chrome.tabs.get(tabId);
      const resp = await chrome.tabs.sendMessage(tabId, { type: "CAPTURE_NOW" });

      if (resp?.job_text) {
        job = {
          job_text: String(resp.job_text || ""),
          job_url: tab?.url || "",
          job_title: tab?.title || "",
          capturedAt: new Date().toISOString(),
        };
        await saveJobForTab(tabId, job);
      }
    } catch {
      // ignore
    }
  }

  if (!job?.job_text) {
    await setBadge(tabId, 0);
    const result = {
      p: 0,
      report:
        'REPORT (conversational analysis):\n"""\nCould not capture job description. Triple-click the JD section on the page.\n"""',
      json: {
        status: "ELIGIBLE",
        blocker_type: null,
        blocker_text: null,
        eligible_for_opt: true,
        match_score: 0,
        recommendation: "BORDERLINE",
        requirements: [],
      },
    };
    await saveAnalysisForTab(tabId, result);
    return result;
  }

  // 3) Tab fallback metadata
  let tab = null;
  try {
    tab = await chrome.tabs.get(tabId);
  } catch {
    tab = null;
  }

  // 4) Backend call
  let result;
  try {
    result = await callBackend({
      resume_text,
      job_text: job.job_text,
      job_url: job.job_url || tab?.url || "",
      job_title: job.job_title || tab?.title || "",
    });
  } catch (err) {
    console.error("[JobMatch] Backend call failed:", err);

    result = {
      p: 0,
      report:
        'REPORT (conversational analysis):\n"""\nBackend is not reachable or returned an error.\n- Check server is running on http://localhost:3000\n- Check /match-resume endpoint\n"""\n',
      json: {
        status: "ELIGIBLE",
        blocker_type: null,
        blocker_text: null,
        eligible_for_opt: true,
        match_score: 0,
        recommendation: "BORDERLINE",
        requirements: [],
      },
    };
  }

  // 5) Save results
  const percent = typeof result?.p === "number" ? result.p : 0;
  await setBadge(tabId, percent);

  await saveAnalysisForTab(tabId, result, {
    job_url: job.job_url || tab?.url || "",
    job_title: job.job_title || tab?.title || "",
  });

  // 6) Notify
  if (result?.json?.status === "REJECTED") {
    await notify("Job Match Analyzer", "Blocked role detected (OPT/F-1). Do not apply.");
  } else {
    await notify("Job Match Analyzer", `Match: ${percent}%`);
  }

  return result;
}

// Message handling
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  (async () => {
    try {
      const type = msg?.type;

      // ✅ Existing flow: content captured JD → background stores it → auto-analyzes
      if (type === "JOB_CAPTURED") {
        const tabId = sender?.tab?.id;
        if (!tabId) return sendResponse({ ok: false, error: "No tabId" });

        const tab = await chrome.tabs.get(tabId);
        const job = {
          job_text: String(msg.job_text || ""),
          job_url: tab?.url || "",
          job_title: tab?.title || "",
          capturedAt: new Date().toISOString(),
        };

        await saveJobForTab(tabId, job);
        const result = await analyzeTab(tabId); // uses stored job + resume
        return sendResponse({ ok: true, result });
      }

      // ✅ NEW: content.js wants “capture + analyze now” and expects result back
      if (type === "AUTO_ANALYZE") {
        const tabId = sender?.tab?.id;
        if (!tabId) return sendResponse({ ok: false, error: "No tabId" });

        const payload = msg?.payload || {};
        const result = await analyzeTab(tabId, payload);
        return sendResponse({ ok: true, result });
      }

      if (type === "ANALYZE_ACTIVE_TAB") {
        const tab = await getActiveTab();
        if (!tab?.id) return sendResponse({ ok: false });
        const result = await analyzeTab(tab.id);
        return sendResponse({ ok: true, result });
      }

      if (type === "ANALYZE_TAB") {
        const tabId = Number(msg.tabId);
        if (!tabId) return sendResponse({ ok: false });
        const result = await analyzeTab(tabId);
        return sendResponse({ ok: true, result });
      }

      return sendResponse({ ok: false, error: "Unknown message type" });
    } catch (err) {
      console.error("[JobMatch] background handler error:", err);
      return sendResponse({ ok: false, error: err?.message || String(err) });
    }
  })();

  return true; // async
});
