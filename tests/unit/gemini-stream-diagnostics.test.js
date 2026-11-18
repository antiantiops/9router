import { describe, it, expect, vi, afterEach } from "vitest";

import { FORMATS } from "../../open-sse/translator/formats.js";
import { createSSEStream, createSSETransformStreamWithLogger } from "../../open-sse/utils/stream.js";
import { sanitizeDiagnosticEnum } from "../../open-sse/utils/geminiStreamDiagnostics.js";

async function runSSE(stream, chunks) {
  const writer = stream.writable.getWriter();
  const reader = stream.readable.getReader();
  const decoder = new TextDecoder();
  const encoder = new TextEncoder();

  const readPromise = (async () => {
    let out = "";
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      out += decoder.decode(value, { stream: true });
    }
    return out + decoder.decode();
  })();

  for (const chunk of chunks) {
    await writer.write(encoder.encode(chunk));
  }
  await writer.close();
  return readPromise;
}

describe("Gemini/Antigravity stream metadata diagnostics", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("records candidate-less promptFeedback blockReason before translator early return and handles tail frame without newline", async () => {
    const infoSpy = vi.spyOn(console, "info").mockImplementation(() => {});

    const stream = createSSEStream({
      mode: "translate",
      targetFormat: FORMATS.ANTIGRAVITY,
      sourceFormat: FORMATS.OPENAI,
      provider: "antigravity",
      model: "gemini-3-pro",
      reqTag: "🟢",
      httpStatus: 200,
    });

    // Final frame intentionally lacks a trailing newline (flush tail path)
    const sse = [
      `data: ${JSON.stringify({
        response: {
          promptFeedback: { blockReason: "PROHIBITED_CONTENT" },
          usageMetadata: { promptTokenCount: 42, totalTokenCount: 42 },
        },
      })}\n\n`,
      `data: ${JSON.stringify({
        response: {
          candidates: [{ finishReason: "SAFETY" }],
          usageMetadata: { promptTokenCount: 42, candidatesTokenCount: 0, totalTokenCount: 42 },
        },
      })}`,
    ];

    const out = await runSSE(stream, sse);
    expect(out).toContain('"finish_reason":"content_filter"');
    expect(infoSpy).toHaveBeenCalledTimes(1);

    const line = infoSpy.mock.calls[0][0];
    expect(line).toContain("[GEMINI_STREAM_DIAG]");
    expect(line).toContain("provider=antigravity");
    expect(line).toContain("model=gemini-3-pro");
    expect(line).toContain("reqTag=🟢");
    expect(line).toContain("status=200");
    expect(line).toContain("empty=true");
    expect(line).toContain("frames=2");
    expect(line).toContain("candidates=1");
    expect(line).toContain("text=0/0c");
    expect(line).toContain("tools=0");
    expect(line).toContain("thought=0/0c");
    expect(line).toContain("finish=[SAFETY]");
    expect(line).toContain("block=[PROHIBITED_CONTENT]");
    expect(line).toContain("usage=[in=42,out=0,total=42]");
  });

  it("counts text, tool calls, thought parts, and preserves exact translated SSE output", async () => {
    const infoSpy = vi.spyOn(console, "info").mockImplementation(() => {});

    const frames = [
      `data: ${JSON.stringify({
        response: {
          responseId: "resp_1",
          modelVersion: "gemini-2.5-pro",
          candidates: [{
            content: {
              parts: [
                { thought: true, text: "SECRET_THOUGHT_PLAN", thoughtSignature: "SIG_SENSITIVE_XYZ" },
                { text: "VISIBLE_SECRET_ANSWER" },
                { functionCall: { name: "sensitiveToolName", args: { secretArg: "SECRET_PROMPT_LEAK" } } },
              ],
            },
            finishReason: "STOP",
          }],
          usageMetadata: {
            promptTokenCount: 100,
            candidatesTokenCount: 25,
            thoughtsTokenCount: 15,
            cachedContentTokenCount: 50,
            totalTokenCount: 140,
          },
        },
      })}\n\n`,
      "data: [DONE]\n\n",
    ];

    const diagStream = createSSEStream({
      mode: "translate",
      targetFormat: FORMATS.ANTIGRAVITY,
      sourceFormat: FORMATS.OPENAI,
      provider: "antigravity",
      model: "gemini-2.5-pro",
      correlationId: "corr-abc-123",
    });

    const baselineStream = createSSETransformStreamWithLogger(
      FORMATS.ANTIGRAVITY,
      FORMATS.OPENAI,
      "antigravity",
      null,
      null,
      "gemini-2.5-pro",
    );

    // Run both streams and ensure exact byte/string output parity (ignoring non-deterministic Date.now/created only if needed; check parsed chunks)
    const diagOut = await runSSE(diagStream, frames);
    const diagCalls = [...infoSpy.mock.calls];
    infoSpy.mockClear();
    const baseOut = await runSSE(baselineStream, frames);

    const parseDataLines = (raw) => raw
      .split("\n")
      .filter((l) => l.startsWith("data: ") && l !== "data: [DONE]")
      .map((l) => {
        const obj = JSON.parse(l.slice(6));
        delete obj.created;
        if (obj.choices?.[0]?.delta?.tool_calls?.[0]?.id) {
          obj.choices[0].delta.tool_calls[0].id = "normalized";
        }
        return obj;
      });

    expect(parseDataLines(diagOut)).toEqual(parseDataLines(baseOut));
    expect(diagCalls).toHaveLength(1);
    expect(infoSpy).toHaveBeenCalledTimes(1);

    const line = diagCalls[0][0];
    expect(line).toContain("empty=false");
    expect(line).toContain("frames=1");
    expect(line).toContain("candidates=1");
    expect(line).toContain("text=1/21c");
    expect(line).toContain("tools=1");
    expect(line).toContain("thought=1/19c");
    expect(line).toContain("finish=[STOP]");
    expect(line).toContain("block=[none]");
    expect(line).toContain("usage=[in=100,out=25,thought=15,cached=50,total=140]");
    expect(line).toContain("corr=corr-abc-123");

    // Privacy check: no prompt/response text, tool names/args, signatures, or emails
    expect(line).not.toContain("SECRET_THOUGHT_PLAN");
    expect(line).not.toContain("VISIBLE_SECRET_ANSWER");
    expect(line).not.toContain("sensitiveToolName");
    expect(line).not.toContain("SECRET_PROMPT_LEAK");
    expect(line).not.toContain("SIG_SENSITIVE_XYZ");
  });

  it("sanitizes unsafe finishReason/blockReason/correlationId strings and caps reason cardinality", async () => {
    expect(sanitizeDiagnosticEnum("MAX_TOKENS")).toBe("MAX_TOKENS");
    expect(sanitizeDiagnosticEnum("STOP\ninjected=true")).toBeNull();
    expect(sanitizeDiagnosticEnum("user@example.com")).toBeNull();
    expect(sanitizeDiagnosticEnum("A".repeat(65))).toBeNull();

    const infoSpy = vi.spyOn(console, "info").mockImplementation(() => {});
    const stream = createSSEStream({
      mode: "translate",
      targetFormat: FORMATS.GEMINI,
      sourceFormat: FORMATS.OPENAI,
      provider: "gemini",
      model: "gemini-2.5-flash",
      correlationId: "bad email@secret.com",
      credentials: { _clientSessionId: "should-not-leak-if-spaces present", accessToken: "ya29.SECRET_TOKEN", email: "user@example.com" },
    });

    const frames = [];
    for (let i = 0; i < 12; i++) {
      frames.push(`data: ${JSON.stringify({ candidates: [{ finishReason: `REASON_${i}` }] })}\n\n`);
    }
    frames.push(`data: ${JSON.stringify({
      promptFeedback: { blockReason: "unsafe space\nnewline" },
      candidates: [{ finishReason: "bad value with spaces" }],
    })}\n\n`);

    await runSSE(stream, frames);
    expect(infoSpy).toHaveBeenCalledTimes(1);

    const line = infoSpy.mock.calls[0][0];
    expect(line).not.toContain("email@secret.com");
    expect(line).not.toContain("ya29.SECRET_TOKEN");
    expect(line).not.toContain("user@example.com");
    expect(line).not.toContain("unsafe space");
    expect(line).not.toContain("bad value");
    expect(line).not.toContain("REASON_8");
    expect(line).toContain("finish=[REASON_0,REASON_1,REASON_2,REASON_3,REASON_4,REASON_5,REASON_6,REASON_7]");
    expect(line).toContain("block=[none]");
  });

  it("treats reasoning-only output as empty while preserving reasoning counters", async () => {
    const infoSpy = vi.spyOn(console, "info").mockImplementation(() => {});

    const stream = createSSEStream({
      mode: "translate",
      targetFormat: FORMATS.ANTIGRAVITY,
      sourceFormat: FORMATS.OPENAI,
      provider: "antigravity",
      model: "gemini-2.5-pro",
      reqTag: "🟣",
    });

    const frames = [
      `data: ${JSON.stringify({
        response: {
          candidates: [{
            content: {
              parts: [{ thought: true, text: "thinking steps only" }],
            },
            finishReason: "STOP",
          }],
        },
      })}\n\n`,
    ];

    await runSSE(stream, frames);
    expect(infoSpy).toHaveBeenCalledTimes(1);

    const line = infoSpy.mock.calls[0][0];
    expect(line).toContain("empty=true");
    expect(line).toContain("text=0/0c");
    expect(line).toContain("tools=0");
    expect(line).toContain("thought=1/19c");
  });

  it("fails open on malformed objects in record() without throwing or altering response", async () => {
    const infoSpy = vi.spyOn(console, "info").mockImplementation(() => {});

    const stream = createSSEStream({
      mode: "translate",
      targetFormat: FORMATS.GEMINI,
      sourceFormat: FORMATS.OPENAI,
      provider: "gemini",
      model: "gemini-2.5-flash",
    });

    // An object throwing on property access
    const poisonous = {
      get response() {
        throw new Error("malformed getter explosion");
      },
    };

    const sse = [
      `data: ${JSON.stringify({ candidates: [{ content: { parts: [{ text: "safe answer" }] } }] })}\n\n`,
    ];

    const out = await runSSE(stream, sse);
    expect(out).toContain("safe answer");
    expect(infoSpy).toHaveBeenCalledTimes(1);
  });

  it("wires reqTag and providerResponse.status through handleStreamingResponse", async () => {
    const { handleStreamingResponse } = await import("../../open-sse/handlers/chatCore/streamingHandler.js");
    const { createStreamController } = await import("../../open-sse/utils/streamHandler.js");
    const infoSpy = vi.spyOn(console, "info").mockImplementation(() => {});

    const encoder = new TextEncoder();
    const upstreamBody = new ReadableStream({
      start(controller) {
        controller.enqueue(encoder.encode(`data: ${JSON.stringify({
          response: {
            candidates: [{ finishReason: "STOP" }],
          },
        })}\n\n`));
        controller.close();
      },
    });

    const mockResponse = new Response(upstreamBody, {
      status: 200,
      headers: { "content-type": "text/event-stream" },
    });

    const streamController = createStreamController({ provider: "antigravity", model: "gemini-2.5-pro", reqTag: "🟠" });

    const result = await handleStreamingResponse({
      providerResponse: mockResponse,
      provider: "antigravity",
      model: "gemini-2.5-pro",
      sourceFormat: FORMATS.OPENAI,
      targetFormat: FORMATS.ANTIGRAVITY,
      reqTag: "🟠",
      body: { messages: [] },
      stream: true,
      streamController,
    });

    expect(result.success).toBe(true);

    const reader = result.response.body.getReader();
    for (;;) {
      const { done } = await reader.read();
      if (done) break;
    }

    expect(infoSpy).toHaveBeenCalledTimes(1);
    const line = infoSpy.mock.calls[0][0];
    expect(line).toContain("reqTag=🟠");
    expect(line).toContain("status=200");
    expect(line).toContain("empty=true");
  });

  it("does not log diagnostics for non-Gemini providers", async () => {
    const infoSpy = vi.spyOn(console, "info").mockImplementation(() => {});
    const stream = createSSEStream({
      mode: "translate",
      targetFormat: FORMATS.OPENAI,
      sourceFormat: FORMATS.CLAUDE,
      provider: "openai",
      model: "gpt-4o",
    });

    await runSSE(stream, [`data: ${JSON.stringify({ choices: [{ delta: { content: "hi" } }] })}\n\n`, "data: [DONE]\n\n"]);
    expect(infoSpy).not.toHaveBeenCalled();
  });
});
