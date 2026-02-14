/* global chrome */
import React, { useEffect, useMemo, useRef, useState } from "react";
import "./popup.css";

const RESUME_KEY = (tabId) => `jobmatch:resume:${tabId}`;
const ANALYSIS_KEY = (tabId) => `jobmatch:analysis:${tabId}`;
const JOB_KEY = (tabId) => `jobmatch:job:${tabId}`;

// ✅ NEW: per-tab candidate name storage
const CANDIDATE_KEY = (tabId) => `jobmatch:candidate:${tabId}`;

function safeJson(v) {
  try {
    return JSON.stringify(v, null, 2);
  } catch {
    return String(v);
  }
}

async function copyToClipboard(text) {
  const t = String(text || "");
  try {
    await navigator.clipboard.writeText(t);
    return true;
  } catch {
    try {
      const ta = document.createElement("textarea");
      ta.value = t;
      document.body.appendChild(ta);
      ta.select();
      document.execCommand("copy");
      document.body.removeChild(ta);
      return true;
    } catch {
      return false;
    }
  }
}

function uniq(arr) {
  const s = new Set();
  const out = [];
  for (const x of arr) {
    const k = String(x || "").trim();
    if (!k || s.has(k)) continue;
    s.add(k);
    out.push(k);
  }
  return out;
}

function isSkillsOrTools(category) {
  const c = String(category || "").toLowerCase();
  return c.includes("tools") || c.includes("skills");
}

function isYearsCategory(category) {
  const c = String(category || "").toLowerCase();
  return c.includes("years");
}

function isLocationLikeRequirement(text) {
  const t = String(text || "").toLowerCase();
  return (
    t.includes("remote") ||
    t.includes("hybrid") ||
    t.includes("on-site") ||
    t.includes("onsite") ||
    t.includes("location") ||
    t.includes("relocate")
  );
}

function isPossibleMustHave(reqText) {
  const t = String(reqText || "").toLowerCase();
  return (
    t.includes("must") ||
    t.includes("required") ||
    t.includes("requirement") ||
    t.includes("mandatory") ||
    t.includes("minimum")
  );
}

function levelBadge(level) {
  if (level === "Exact") return "badge ok";
  if (level === "Close" || level === "Partial") return "badge warn";
  return "badge bad";
}

function inferDomainFromTitle(title = "") {
  const t = String(title || "").toLowerCase();

  if (t.includes("software") || t.includes("developer") || t.includes("engineer") || t.includes("full stack")) return "Tech";
  if (t.includes("data") || t.includes("analyst") || t.includes("ml") || t.includes("machine learning")) return "Data";
  if (t.includes("product") || t.includes("pm")) return "Product";
  if (t.includes("marketing") || t.includes("seo") || t.includes("growth")) return "Marketing";
  if (t.includes("sales") || t.includes("account executive") || t.includes("business development")) return "Sales";
  if (t.includes("recruit") || t.includes("talent") || t.includes("hr") || t.includes("human resources")) return "HR";
  if (t.includes("finance") || t.includes("accounting") || t.includes("fp&a")) return "Finance";
  if (t.includes("operations") || t.includes("ops")) return "Operations";
  if (t.includes("customer success") || t.includes("client success") || t.includes("cs")) return "Customer Success";

  return "General";
}

function formatDateTime(iso) {
  try {
    if (!iso) return null;
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return null;
    return d.toLocaleString();
  } catch {
    return null;
  }
}

function deriveSkillsFromRequirements(json) {
  // const reqs = Array.isArray(json?.requirements) ? json.requirements : [];
  // Works on both old+new backend
  const reqs = Array.isArray(json?.requirements)
    ? json.requirements
    : (Array.isArray(json?.requirements_top10) ? json.requirements_top10 : []);

  // ✅ Prefer explicit backend lists if available
  // const explicitMatched = Array.isArray(json?.matched_skills) ? json.matched_skills : null;
  // const explicitMissingMust = Array.isArray(json?.missing_must_have_skills) ? json.missing_must_have_skills : null;
  // const explicitMissingPref = Array.isArray(json?.missing_preferred_skills) ? json.missing_preferred_skills : null;
  const explicitMatched =
    Array.isArray(json?.matched_skills_top5) ? json.matched_skills_top5 :
      (Array.isArray(json?.matched_skills) ? json.matched_skills : null);

  const explicitMissingMust =
    Array.isArray(json?.missing_must_have_skills_top5) ? json.missing_must_have_skills_top5 :
      (Array.isArray(json?.missing_must_have_skills) ? json.missing_must_have_skills : null);

  const explicitMissingPref =
    Array.isArray(json?.missing_preferred_skills_top5) ? json.missing_preferred_skills_top5 :
      (Array.isArray(json?.missing_preferred_skills) ? json.missing_preferred_skills : null);

  if (explicitMatched || explicitMissingMust || explicitMissingPref) {
    const matched = uniq(explicitMatched || []);
    const unmatched = uniq([...(explicitMissingMust || []), ...(explicitMissingPref || [])]);
    return {
      matched,
      unmatched,
      total: matched.length + unmatched.length,
    };
  }

  // fallback: derive from requirements
  const skillReqs = reqs.filter((r) => isSkillsOrTools(r.category));
  const matched = uniq(skillReqs.filter((r) => r.match_level !== "Missing").map((r) => r.requirement));
  const unmatched = uniq(skillReqs.filter((r) => r.match_level === "Missing").map((r) => r.requirement));
  return { matched, unmatched, total: matched.length + unmatched.length };
}

function buildGapsByGroup(reqs) {
  const groups = {
    "Tools & Technologies": [],
    "Domain / Industry": [],
    "Regulatory / Compliance": [],
    "Outcomes / Impact": [],
    Other: [],
  };

  for (const r of reqs) {
    if (r.match_level !== "Missing") continue;

    const c = String(r.category || "").toLowerCase();
    if (c.includes("tools")) groups["Tools & Technologies"].push(r);
    else if (c.includes("domain") || c.includes("industry")) groups["Domain / Industry"].push(r);
    else if (c.includes("regulatory") || c.includes("compliance")) groups["Regulatory / Compliance"].push(r);
    else if (c.includes("outcomes") || c.includes("impact")) groups["Outcomes / Impact"].push(r);
    else groups.Other.push(r);
  }

  return groups;
}

// ✅ NEW: extract candidate name from pasted resume text (best-effort)
function extractCandidateName(resumeText = "") {
  const text = String(resumeText || "").replace(/\r/g, "");
  const lines = text
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);

  if (!lines.length) return "";

  // Pattern: "Name: John Doe"
  for (const l of lines.slice(0, 8)) {
    const m = l.match(/^(name|candidate|full\s*name)\s*[:\-]\s*(.+)$/i);
    if (m?.[2]) return m[2].trim().slice(0, 60);
  }

  const isEmail = (s) => /@/.test(s);
  const isPhone = (s) => /(\+?\d[\d\s().-]{7,}\d)/.test(s);

  const pickIfNameLike = (s) => {
    if (!s) return "";
    if (isEmail(s) || isPhone(s)) return "";
    if (s.length > 45) return "";
    // basic "Name-like" (letters + spaces + .'-)
    if (!/^[a-zA-Z][a-zA-Z\s.'-]{2,}$/.test(s)) return "";
    return s.slice(0, 60);
  };

  const first = pickIfNameLike(lines[0]);
  if (first) return first;

  for (const l of lines.slice(0, 10)) {
    const v = pickIfNameLike(l);
    if (v) return v;
  }

  return "";
}

export default function App() {
  const [tabId, setTabId] = useState(null);
  const [resumeText, setResumeText] = useState("");
  const [analysis, setAnalysis] = useState(null);
  const [jobMeta, setJobMeta] = useState({ title: "", url: "" });
  const [toast, setToast] = useState("");
  const [isResumeDirty, setIsResumeDirty] = useState(false);

  // ✅ NEW: candidate name shown at top, stored per-tab
  const [candidateName, setCandidateName] = useState("");

  const resumeRef = useRef(null);

  // ✅ NEW: robust dirty ref to avoid interval wiping paste
  const resumeDirtyRef = useRef(false);

  const json = analysis?.json || null;
  const status = json?.status || null; // ELIGIBLE / REJECTED
  const percent = typeof analysis?.p === "number" ? analysis.p : null;
  const matchScore = typeof json?.match_score === "number" ? json.match_score : null;

  const lastAnalyzed = useMemo(() => formatDateTime(analysis?.analyzedAt), [analysis?.analyzedAt]);
  const domain = useMemo(() => inferDomainFromTitle(jobMeta?.title || ""), [jobMeta?.title]);

  // const requirements = useMemo(() => (Array.isArray(json?.requirements) ? json.requirements : []), [json]);
  const requirements = useMemo(() => {
    // if (Array.isArray(json?.requirements)) return json.requirements;           // old backend
    if (Array.isArray(json?.requirements_top10)) return json.requirements_top10; // new backend
    return [];
  }, [json]);

  // ✅ NEW: Prefer explicit backend experience/location fields
  const experienceFromBackend = useMemo(() => {
    const req = String(json?.experience_required || "").trim();
    const cand = String(json?.experience_candidate || "").trim();
    const match = typeof json?.experience_match === "boolean" ? json.experience_match : null;
    return { req, cand, match };
  }, [json]);

  const locationFromBackend = useMemo(() => {
    const req = String(json?.location_required || "").trim();
    const cand = String(json?.location_candidate || "").trim();
    const match = typeof json?.location_match === "boolean" ? json.location_match : null;
    return { req, cand, match };
  }, [json]);

  const skillSummary = useMemo(() => deriveSkillsFromRequirements(json), [json]);

  const matchedSkills = skillSummary.matched;
  const unmatchedSkills = skillSummary.unmatched;

  const topMatchedSkills = useMemo(() => matchedSkills.slice(0, 5), [matchedSkills]);
  const topUnmatchedSkills = useMemo(() => unmatchedSkills.slice(0, 5), [unmatchedSkills]);

  const skillsCoveragePct = useMemo(() => {
    const total = skillSummary.total;
    if (!total) return 0;
    return Math.round((matchedSkills.length / total) * 100);
  }, [skillSummary.total, matchedSkills.length]);

  // Quick checks (best-effort) + backend-first
  const experienceReq = useMemo(() => requirements.find((r) => isYearsCategory(r.category)), [requirements]);
  const experienceStatus = useMemo(() => {
    if (experienceFromBackend.req) {
      if (experienceFromBackend.match === true) return { label: "Matched", tone: "ok" };
      if (experienceFromBackend.match === false) return { label: "Not matched", tone: "bad" };
      return { label: "Unknown", tone: "muted" };
    }
    if (!experienceReq) return { label: "Not Mentioned", tone: "muted" };
    if (experienceReq.match_level === "Missing") return { label: "Not met", tone: "bad" };
    return { label: "Likely met", tone: "ok" };
  }, [experienceFromBackend, experienceReq]);

  const locationReq = useMemo(
    () => requirements.find((r) => isLocationLikeRequirement(r.requirement)),
    [requirements]
  );
  const locationStatus = useMemo(() => {
    if (locationFromBackend.req) {
      if (locationFromBackend.match === true) return { label: "Matched", tone: "ok" };
      if (locationFromBackend.match === false) return { label: "Not matched", tone: "bad" };
      return { label: "Unknown", tone: "muted" };
    }
    if (!locationReq) return { label: "Not Mentioned", tone: "muted" };
    if (locationReq.match_level === "Missing") return { label: "No", tone: "bad" };
    return { label: "Yes", tone: "ok" };
  }, [locationFromBackend, locationReq]);

  // ✅ Must-have missing: prefer backend list, then priority, then heuristic
  const mustHaveMissing = useMemo(() => {
    const base = requirements.filter((r) => isSkillsOrTools(r.category) && r.match_level === "Missing");

    const explicit = Array.isArray(json?.missing_must_have_skills) ? json.missing_must_have_skills : null;
    if (explicit && explicit.length) {
      const set = new Set(explicit.map((s) => String(s).toLowerCase()));
      return base.filter((r) => set.has(String(r.requirement).toLowerCase())).slice(0, 10);
    }

    const hasPriority = base.some((r) => typeof r.priority === "string");
    if (hasPriority) return base.filter((r) => r.priority === "must_have").slice(0, 10);

    return base.filter((r) => isPossibleMustHave(r.requirement)).slice(0, 10);
  }, [requirements, json?.missing_must_have_skills]);

  // ✅ Preferred missing: prefer backend list, then priority
  const preferredMissing = useMemo(() => {
    const base = requirements.filter((r) => isSkillsOrTools(r.category) && r.match_level === "Missing");

    const explicit = Array.isArray(json?.missing_preferred_skills) ? json.missing_preferred_skills : null;
    if (explicit && explicit.length) {
      const set = new Set(explicit.map((s) => String(s).toLowerCase()));
      return base.filter((r) => set.has(String(r.requirement).toLowerCase())).slice(0, 12);
    }

    const hasPriority = base.some((r) => typeof r.priority === "string");
    if (hasPriority) return base.filter((r) => r.priority === "preferred").slice(0, 12);

    return [];
  }, [requirements, json?.missing_preferred_skills]);

  const gapsByGroup = useMemo(() => buildGapsByGroup(requirements), [requirements]);

  // const improvements = useMemo(() => {
  //   const suggestions = [];
  //   for (const r of requirements) {
  //     if (Array.isArray(r.suggestions)) suggestions.push(...r.suggestions);
  //   }
  //   return uniq(suggestions).slice(0, 8);
  // }, [requirements]);

  const improvements = useMemo(() => {
    // ✅ 1) Prefer backend top list (new)
    const fromBackend =
      Array.isArray(json?.improvements_top5) ? json.improvements_top5
        : (Array.isArray(json?.improvements_top6) ? json.improvements_top6 : null);

    if (fromBackend && fromBackend.length) {
      // backend items could be strings OR objects {improvement, example_bullet}
      const asStrings = fromBackend.map((x) => {
        if (typeof x === "string") return x;
        if (x && typeof x === "object") return x.improvement || "";
        return "";
      });
      return uniq(asStrings).slice(0, 5);
    }

    // ✅ 2) Fallback: derive from requirement suggestions
    const suggestions = [];
    for (const r of requirements) {
      if (Array.isArray(r.suggestions)) suggestions.push(...r.suggestions);
    }
    return uniq(suggestions).slice(0, 5);
  }, [json, requirements]);

  async function loadAll() {
    const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
    const t = tabs?.[0];
    if (!t?.id) return;
    setTabId(t.id);

    resumeDirtyRef.current = false;
    setIsResumeDirty(false);

    // const { resumeText: savedResume } = await chrome.storage.local.get({ resumeText: "" });
    // const savedResumeStr = String(savedResume || "");

    const key = RESUME_KEY(t.id);
    const data = await chrome.storage.local.get({ [key]: "" });
    const savedResumeStr = String(data?.[key] || "");

    // ✅ DO NOT overwrite textarea while user is editing/pasting
    const resumeIsFocused = resumeRef.current && document.activeElement === resumeRef.current;
    if (!resumeDirtyRef.current && !resumeIsFocused) {
      setResumeText(savedResumeStr);
    }

    // ✅ NEW: read per-tab candidate name (session)
    const candData = await chrome.storage.session.get(CANDIDATE_KEY(t.id));
    const savedCandidate = String(candData?.[CANDIDATE_KEY(t.id)] || "");
    setCandidateName(savedCandidate);

    const jobData = await chrome.storage.session.get(JOB_KEY(t.id));
    const job = jobData?.[JOB_KEY(t.id)] || null;
    setJobMeta({ title: job?.job_title || t.title || "", url: job?.job_url || t.url || "" });

    const analysisData = await chrome.storage.session.get(ANALYSIS_KEY(t.id));
    const a = analysisData?.[ANALYSIS_KEY(t.id)] || null;
    setAnalysis(a);
  }

  useEffect(() => {
    loadAll();
    const id = setInterval(loadAll, 1200);
    return () => clearInterval(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function showToastMsg(msg) {
    setToast(msg);
    setTimeout(() => setToast(""), 1600);
  }

  async function saveResume() {

    // await chrome.storage.local.set({ resumeText });

    if (!tabId) return;
    await chrome.storage.local.set({ [RESUME_KEY(tabId)]: resumeText });

    // ✅ NEW: extract + store per-tab candidate name
    const name = extractCandidateName(resumeText);
    if (tabId) {
      await chrome.storage.session.set({ [CANDIDATE_KEY(tabId)]: name || "" });
    }
    setCandidateName(name || "");

    setIsResumeDirty(false);
    resumeDirtyRef.current = false;

    showToastMsg(name ? `Resume saved ✅ (${name})` : "Resume saved ✅");
  }

  async function clearResume() {
    // await chrome.storage.local.set({ resumeText: "" });
    if (!tabId) return;
    await chrome.storage.local.set({ [RESUME_KEY(tabId)]: "" });

    setResumeText("");

    // ✅ clear candidate name for this tab too
    if (tabId) {
      await chrome.storage.session.set({ [CANDIDATE_KEY(tabId)]: "" });
    }
    setCandidateName("");

    setIsResumeDirty(false);
    resumeDirtyRef.current = false;

    showToastMsg("Resume cleared 🗑️");
  }

  async function reAnalyze() {
    showToastMsg("Analyzing…");
    await chrome.runtime.sendMessage({ type: "ANALYZE_ACTIVE_TAB" });
  }

  async function copyReport() {
    const ok = await copyToClipboard(analysis?.report || "");
    showToastMsg(ok ? "Report copied ✅" : "Copy failed ❌");
  }

  async function copyJson() {
    const ok = await copyToClipboard(json ? safeJson(json) : "");
    showToastMsg(ok ? "JSON copied ✅" : "Copy failed ❌");
  }

  // -----------------------
  // UI STARTS HERE
  // Resume card is FIRST (top)
  // -----------------------
  return (
    <div className="wrap">
      {/* ✅ NEW: Candidate Name Heading (tab-wise) */}
      <div className="candidateHeader">
        <div className="candidateName">
          {candidateName ? candidateName : "Candidate (name not detected)"}
        </div>
        <div className="candidateMeta">
          Tab: <span className="mono">{tabId ?? "-"}</span>
        </div>
      </div>

      {/* RESUME AT TOP */}
      <div className="card">
        <div className="label">Resume (paste Skills/Summary/Experience)</div>
        <textarea
          ref={resumeRef}
          value={resumeText}
          onChange={(e) => {
            const v = e.target.value;
            setResumeText(v);

            setIsResumeDirty(true);
            resumeDirtyRef.current = true;

            // ✅ live preview name (without saving)
            const name = extractCandidateName(v);
            setCandidateName(name || "");
          }}
          placeholder="Paste your resume text here..."
        />
        <div className="btnRow">
          <button className="btn" onClick={saveResume}>Save Resume</button>

          <button className="btn ghost" onClick={reAnalyze} disabled={!tabId || !resumeText.trim()}>
            Re-analyze
          </button>

          <button className="btn ghost dangerText" onClick={clearResume} disabled={!resumeText.trim()}>
            Clear Resume
          </button>
        </div>

        {matchScore !== null ? (
          <div className="mutedSmall">
            Backend match_score: <span className="mono">{matchScore.toFixed(1)}%</span>
            {lastAnalyzed ? (
              <>
                {" "}• Last analyzed: <span className="mono">{lastAnalyzed}</span>
              </>
            ) : null}
          </div>
        ) : (
          <div className="mutedSmall">
            Tip: Triple-click any job description to auto-analyze.
            {lastAnalyzed ? (
              <>
                {" "}• Last analyzed: <span className="mono">{lastAnalyzed}</span>
              </>
            ) : null}
          </div>
        )}
      </div>

      {/* HEADER / DECISION */}
      <div className="header">
        <div>
          <div className="title">Job Match Analyzer</div>
          <div className="sub">
            {jobMeta.title || "Job title not captured yet"}{" "}
            <span className="pill muted" style={{ marginLeft: 8 }}>{domain}</span>
          </div>
          {jobMeta.url ? (
            <div className="mutedSmall mono" title={jobMeta.url}>
              {jobMeta.url}
            </div>
          ) : null}
        </div>

        <div className="rightHeader">
          <div className="scoreBox">
            {/* ✅ bigger score by adding scoreBig class */}
            <div className="score scoreBig">{percent ?? 0}%</div>
            {status === "REJECTED" ? (
              <div className="pill bad">BLOCKED</div>
            ) : (
              <div className="pill ok">ELIGIBLE</div>
            )}
            <div className="mutedSmall" style={{ marginTop: 6 }}>
              {lastAnalyzed ? `Last analyzed: ${lastAnalyzed}` : "Not analyzed yet"}
            </div>
          </div>
        </div>
      </div>

      {/* BLOCKED VIEW */}
      {status === "REJECTED" ? (
        <div className="card danger">
          <div className="h1">🚫 DO NOT APPLY</div>
          <div className="mutedSmall">This job contains an OPT/F-1 blocker.</div>

          <div className="kv">
            <div className="k">Blocker quote</div>
            <div className="v mono">{json?.blocker_text || "Blocker detected"}</div>
          </div>

          <div className="btnRow">
            <button className="btn ghost" onClick={copyReport} disabled={!analysis?.report}>Copy Alert</button>
            <button className="btn ghost" onClick={copyJson} disabled={!json}>Copy JSON</button>
          </div>
        </div>
      ) : (
        <>
          {/* QUICK CHECKS */}
          <div className="row2">
            <div className="card">
              <div className="label">Experience</div>
              <div className={`pill ${experienceStatus.tone}`}>{experienceStatus.label}</div>
              <div className="mutedSmall">
                {experienceFromBackend.req ? (
                  <>
                    JD: <span className="mono">{experienceFromBackend.req}</span>
                    <br />
                    Resume: <span className="mono">{experienceFromBackend.cand || "Not found"}</span>
                  </>
                ) : experienceReq ? (
                  <>
                    JD requirement: <span className="mono">{experienceReq.requirement}</span>
                  </>
                ) : (
                  "No years-of-experience requirement detected."
                )}
              </div>
            </div>

            <div className="card">
              <div className="label">Location</div>
              <div className={`pill ${locationStatus.tone}`}>{locationStatus.label}</div>
              <div className="mutedSmall">
                {locationFromBackend.req ? (
                  <>
                    JD: <span className="mono">{locationFromBackend.req}</span>
                    <br />
                    Resume: <span className="mono">{locationFromBackend.cand || "Not found"}</span>
                  </>
                ) : locationReq ? (
                  <>
                    JD cue: <span className="mono">{locationReq.requirement}</span>
                  </>
                ) : (
                  "No location/mode requirement detected."
                )}
              </div>
            </div>
          </div>

          {/* SKILLS COVERAGE */}
          <div className="card">
            <div className="cardTop">
              <div>
                <div className="h2">Skills Coverage</div>
                <div className="mutedSmall">
                  Matched <b>{matchedSkills.length}</b> / Total{" "}
                  <b>{matchedSkills.length + unmatchedSkills.length}</b>
                </div>
              </div>
              <div className="pill">{skillsCoveragePct}%</div>
            </div>

            <div className="bar">
              <div className="barFill" style={{ width: `${skillsCoveragePct}%` }} />
            </div>

            <details open className="details">
              <summary>Matched skills</summary>
              {matchedSkills.length ? (
                <div className="chips">
                  {/* {matchedSkills.map((s, i) => (
                    <span className="chip ok" key={i}>{s}</span>
                  ))} */}
                  {topMatchedSkills.map((s, i) => (
                    <span className="chip ok" key={i}>{s}</span>
                  ))}

                  {matchedSkills.length > 5 ? (
                    <div className="mutedSmall">+{matchedSkills.length - 5} more matched</div>
                  ) : null}
                </div>
              ) : (
                <div className="mutedSmall">No matched skills listed yet.</div>
              )}
            </details>

            <details className="details">
              <summary>Unmatched skills (missing)</summary>
              {unmatchedSkills.length ? (
                <div className="chips">
                  {topUnmatchedSkills.map((s, i) => (
                    <span className="chip bad" key={i}>{s}</span>
                  ))}

                  {unmatchedSkills.length > 5 ? (
                    <div className="mutedSmall">+{unmatchedSkills.length - 5} more missing</div>
                  ) : null}
                </div>
              ) : (
                <div className="mutedSmall">No unmatched skills detected.</div>
              )}
            </details>
          </div>

          {/* MUST-HAVE MISSING */}
          <div className="card">
            <div className="cardTop">
              <div className="h2">Must-have skills (missing)</div>
              <div className="mutedSmall">
                Uses backend STARRED/priority when available; otherwise falls back to “must/required/minimum”.
              </div>
            </div>

            {mustHaveMissing.length ? (
              <div className="list">
                {mustHaveMissing.map((r, idx) => (
                  <div className="listItem" key={idx}>
                    <div className="listLeft">
                      <div className="line1">
                        <span className="dot bad" /> <b>{r.requirement}</b>
                        <span className={levelBadge(r.match_level)}>{r.match_level}</span>
                      </div>
                      <div className="mutedSmall">
                        Evidence: <span className="mono">{r.resume_evidence || "Not found"}</span>
                      </div>
                      {Array.isArray(r.suggestions) && r.suggestions.length ? (
                        <ul className="ul">
                          {r.suggestions.slice(0, 3).map((s, i) => (
                            <li key={i}>{s}</li>
                          ))}
                        </ul>
                      ) : null}
                    </div>
                  </div>
                ))}
              </div>
            ) : (
              <div className="mutedSmall">No must-have missing skills flagged.</div>
            )}
          </div>

          {/* PREFERRED MISSING */}
          <div className="card">
            <div className="cardTop">
              <div className="h2">Preferred skills (missing)</div>
              <div className="mutedSmall">Derived from JD lines marked with “*” (STARRED_ITEMS) when available.</div>
            </div>

            {preferredMissing.length ? (
              <div className="chips">
                {preferredMissing.map((r, i) => (
                  <span className="chip bad" key={i}>{r.requirement}</span>
                ))}
              </div>
            ) : (
              <div className="mutedSmall">No preferred missing skills detected.</div>
            )}
          </div>

          {/* GAPS */}
          <div className="card">
            <div className="h2">Gaps (high-impact missing)</div>

            {Object.entries(gapsByGroup).map(([group, items]) => {
              if (!items.length) return null;
              return (
                <div key={group} className="gapGroup">
                  <div className="gapTitle">{group}</div>
                  <div className="chips">
                    {items.slice(0, 12).map((r, i) => (
                      <span className="chip bad" key={i}>{r.requirement}</span>
                    ))}
                  </div>
                </div>
              );
            })}

            {!Object.values(gapsByGroup).some((v) => v.length) ? (
              <div className="mutedSmall">No high-impact gaps detected.</div>
            ) : null}
          </div>

          {/* IMPROVEMENTS */}
          <div className="card">
            <div className="cardTop">
              <div className="h2">Improvements</div>
              <button
                className="btn tiny"
                onClick={async () => {
                  const ok = await copyToClipboard(improvements.join("\n"));
                  showToastMsg(ok ? "Copied ✅" : "Copy failed ❌");
                }}
                disabled={!improvements.length}
              >
                Copy all
              </button>
            </div>

            {improvements.length ? (
              <div className="list">
                {improvements.slice(0, 5).map((s, i) => (
                  <div className="listItem" key={i}>
                    <div className="listLeft">
                      <div className="line1">
                        <span className="dot warn" /> {s}
                      </div>
                    </div>
                    <button
                      className="btn tiny ghost"
                      onClick={async () => {
                        const ok = await copyToClipboard(s);
                        showToastMsg(ok ? "Copied ✅" : "Copy failed ❌");
                      }}
                    >
                      Copy
                    </button>
                  </div>
                ))}
              </div>
            ) : (
              <div className="mutedSmall">No improvements available yet.</div>
            )}
          </div>

          {/* REPORT + JSON */}
          <details className="card detailsBlock">
            <summary>Report</summary>
            <pre className="pre">{analysis?.report || "No report yet."}</pre>
            <div className="btnRow">
              <button className="btn tiny" onClick={copyReport} disabled={!analysis?.report}>Copy Report</button>
            </div>
          </details>

          {/* <details className="card detailsBlock">
            <summary>Raw JSON</summary>
            <pre className="pre">{json ? safeJson(json) : "No JSON yet."}</pre>
            <div className="btnRow">
              <button className="btn tiny" onClick={copyJson} disabled={!json}>Copy JSON</button>
            </div>
          </details> */}
        </>
      )}

      {toast ? <div className="toast">{toast}</div> : null}
    </div>
  );
}
