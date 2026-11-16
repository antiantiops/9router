import { FORMATS } from "../translator/formats.js";

const GEMINI_FAMILY_FORMATS = new Set([
  FORMATS.GEMINI,
  FORMATS.GEMINI_CLI,
  FORMATS.ANTIGRAVITY,
  FORMATS.VERTEX,
]);

const GEMINI_FAMILY_PROVIDERS = new Set([
  "gemini",
  "gemini-cli",
  "antigravity",
  "vertex",
]);

const SAFE_ENUM_RE = /^[A-Za-z0-9_.:/-]{1,64}$/;
const SAFE_TAG_RE = /^(?:🟢|🔵|🟣|🟡|🟠|🔴|⚪|🟤|[A-Za-z0-9_.:/-]{1,32})$/;
const MAX_REASONS = 8;

// Whitelist safe enum tokens (finishReason / blockReason / correlation id) without raw object serialization.
export function sanitizeDiagnosticEnum(value) {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > 64 || !SAFE_ENUM_RE.test(trimmed)) return null;
  return trimmed;
}

function sanitizeReqTag(value) {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (!trimmed || !SAFE_TAG_RE.test(trimmed)) return null;
  return trimmed;
}

export function isGeminiDiagnosticStream({ targetFormat, provider }) {
  return GEMINI_FAMILY_FORMATS.has(targetFormat) || GEMINI_FAMILY_PROVIDERS.has(provider);
}

function addBoundedReason(set, value) {
  const safe = sanitizeDiagnosticEnum(value);
  if (safe && set.size < MAX_REASONS) set.add(safe);
}

function toFiniteInt(value) {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? Math.trunc(value) : null;
}

export function createGeminiStreamDiagnostics({ provider = null, model = null, targetFormat = null, reqTag = null, correlationId = null, httpStatus = null } = {}) {
  if (!isGeminiDiagnosticStream({ targetFormat, provider })) return null;

  const finishReasons = new Set();
  const blockReasons = new Set();
  const usage = { prompt: null, candidates: null, thoughts: null, cached: null, total: null };

  const stats = {
    frames: 0,
    candidates: 0,
    textParts: 0,
    textChars: 0,
    functionCalls: 0,
    reasoningParts: 0,
    reasoningChars: 0,
  };

  let logged = false;

  const safeProvider = sanitizeDiagnosticEnum(provider) || "unknown";
  const safeModel = sanitizeDiagnosticEnum(model) || "unknown";
  const safeReqTag = sanitizeReqTag(reqTag);
  const safeCorrelationId = sanitizeDiagnosticEnum(correlationId);
  const safeHttpStatus = toFiniteInt(httpStatus);

  return {
    record(parsed) {
      if (!parsed || typeof parsed !== "object") return;
      try {
        stats.frames++;

        const response = parsed.response && typeof parsed.response === "object" ? parsed.response : parsed;
        const promptFeedback = response.promptFeedback || parsed.promptFeedback;
        if (promptFeedback && typeof promptFeedback === "object") {
          addBoundedReason(blockReasons, promptFeedback.blockReason);
        }

        const candidates = Array.isArray(response.candidates) ? response.candidates : null;
        if (candidates) {
          stats.candidates += candidates.length;
          for (const candidate of candidates) {
            if (!candidate || typeof candidate !== "object") continue;
            addBoundedReason(finishReasons, candidate.finishReason);

            const parts = Array.isArray(candidate.content?.parts) ? candidate.content.parts : null;
            if (!parts) continue;
            for (const part of parts) {
              if (!part || typeof part !== "object") continue;
              if (typeof part.text === "string") {
                if (part.thought === true) {
                  stats.reasoningParts++;
                  stats.reasoningChars += part.text.length;
                } else {
                  stats.textParts++;
                  stats.textChars += part.text.length;
                }
              }
              if (part.functionCall && typeof part.functionCall === "object") {
                stats.functionCalls++;
              }
            }
          }
        }

        const usageMeta = response.usageMetadata || parsed.usageMetadata;
        if (usageMeta && typeof usageMeta === "object") {
          const prompt = toFiniteInt(usageMeta.promptTokenCount);
          const cand = toFiniteInt(usageMeta.candidatesTokenCount);
          const thoughts = toFiniteInt(usageMeta.thoughtsTokenCount);
          const cached = toFiniteInt(usageMeta.cachedContentTokenCount);
          const total = toFiniteInt(usageMeta.totalTokenCount);
          if (prompt !== null) usage.prompt = prompt;
          if (cand !== null) usage.candidates = cand;
          if (thoughts !== null) usage.thoughts = thoughts;
          if (cached !== null) usage.cached = cached;
          if (total !== null) usage.total = total;
        }
      } catch {
        // fail-open: malformed upstream objects must never alter response stream
      }
    },

    getSummary() {
      // Empty means no usable text or tools produced for the user, even if reasoning-only was streamed
      const empty = stats.textChars === 0 && stats.functionCalls === 0;
      return {
        provider: safeProvider,
        model: safeModel,
        reqTag: safeReqTag,
        correlationId: safeCorrelationId,
        httpStatus: safeHttpStatus,
        empty,
        frames: stats.frames,
        candidates: stats.candidates,
        textParts: stats.textParts,
        textChars: stats.textChars,
        functionCalls: stats.functionCalls,
        reasoningParts: stats.reasoningParts,
        reasoningChars: stats.reasoningChars,
        finishReasons: [...finishReasons],
        blockReasons: [...blockReasons],
        usage: { ...usage },
      };
    },

    flush(emit = console.info) {
      if (logged) return null;
      logged = true;
      const summary = this.getSummary();
      const finishStr = summary.finishReasons.length ? summary.finishReasons.join(",") : "none";
      const blockStr = summary.blockReasons.length ? summary.blockReasons.join(",") : "none";
      const usageParts = [];
      if (summary.usage.prompt !== null) usageParts.push(`in=${summary.usage.prompt}`);
      if (summary.usage.candidates !== null) usageParts.push(`out=${summary.usage.candidates}`);
      if (summary.usage.thoughts !== null) usageParts.push(`thought=${summary.usage.thoughts}`);
      if (summary.usage.cached !== null) usageParts.push(`cached=${summary.usage.cached}`);
      if (summary.usage.total !== null) usageParts.push(`total=${summary.usage.total}`);
      const usageStr = usageParts.length ? usageParts.join(",") : "none";

      const fields = [
        `provider=${summary.provider}`,
        `model=${summary.model}`,
        ...(summary.reqTag ? [`reqTag=${summary.reqTag}`] : []),
        ...(summary.correlationId ? [`corr=${summary.correlationId}`] : []),
        ...(summary.httpStatus !== null ? [`status=${summary.httpStatus}`] : []),
        `empty=${summary.empty}`,
        `frames=${summary.frames}`,
        `candidates=${summary.candidates}`,
        `text=${summary.textParts}/${summary.textChars}c`,
        `tools=${summary.functionCalls}`,
        `thought=${summary.reasoningParts}/${summary.reasoningChars}c`,
        `finish=[${finishStr}]`,
        `block=[${blockStr}]`,
        `usage=[${usageStr}]`,
      ];
      const line = `[GEMINI_STREAM_DIAG] ${fields.join(" | ")}`;
      try { emit(line); } catch { /* fail-open diagnostics */ }
      return summary;
    },
  };
}
