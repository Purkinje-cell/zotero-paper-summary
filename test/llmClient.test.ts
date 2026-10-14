import { assert } from "chai";
import { testChatConnection } from "../src/modules/llmClient";

const MOCK_PORT = 24602;

/**
 * Self-contained OpenAI-compatible mock served from inside Zotero via
 * nsIServerSocket, so the test needs no external process and runs in CI.
 * Replies 200/MOCK-REPLY for "Bearer good-key", 401 otherwise.
 */
function startMockServer(port: number): { close(): void } {
  const server = Components.classes[
    "@mozilla.org/network/server-socket;1"
  ].createInstance(Components.interfaces.nsIServerSocket);
  server.init(port, true, -1);
  server.asyncListen({
    onSocketAccepted: (_socket, transport) => {
      const input = transport.openInputStream(0, 0, 0);
      const output = transport.openOutputStream(0, 0, 0);
      const pump = Components.classes[
        "@mozilla.org/network/input-stream-pump;1"
      ].createInstance(Components.interfaces.nsIInputStreamPump);
      let raw = "";
      pump.init(input, 0, 0, true);
      pump.asyncRead({
        onStartRequest: () => {},
        onDataAvailable: (_req, stream) => {
          const reader = Components.classes[
            "@mozilla.org/scriptableinputstream;1"
          ].createInstance(Components.interfaces.nsIScriptableInputStream);
          reader.init(stream);
          raw += reader.read(reader.available());
          reader.close();
        },
        onStopRequest: () => {
          const authorized = raw.includes("Authorization: Bearer good-key");
          const status = authorized ? "200 OK" : "401 Unauthorized";
          const body = authorized
            ? JSON.stringify({
                choices: [{ message: { content: "MOCK-REPLY" } }],
              })
            : JSON.stringify({ error: { message: "Invalid API key" } });
          const response =
            `HTTP/1.1 ${status}\r\nContent-Type: application/json\r\n` +
            `Content-Length: ${body.length}\r\nConnection: close\r\n\r\n${body}`;
          output.write(response, response.length);
          output.flush();
          try {
            transport.close();
          } catch {
            // Already closed by peer.
          }
        },
      });
    },
    onStopListening: () => {},
  });
  return {
    close: () => {
      try {
        server.close();
      } catch {
        // Already closed.
      }
    },
  };
}

describe("llm client", function () {
  this.timeout(30000);
  const base = `http://127.0.0.1:${MOCK_PORT}/v1`;
  let mock: { close(): void } | undefined;

  before(function () {
    mock = startMockServer(MOCK_PORT);
  });

  after(function () {
    mock?.close();
  });

  it("reports a successful connection test", async function () {
    const result = await testChatConnection({
      baseURL: base,
      apiKey: "good-key",
      model: "test-model",
    });
    assert.isTrue(result.ok, `expected ok, got error: ${result.error}`);
    assert.equal(result.reply, "MOCK-REPLY");
    assert.isAtLeast(result.ms, 0);
  });

  it("surfaces HTTP error status and provider message", async function () {
    const result = await testChatConnection({
      baseURL: base,
      apiKey: "wrong-key",
      model: "test-model",
    });
    assert.isFalse(result.ok);
    assert.include(result.error ?? "", "401");
    assert.include(result.error ?? "", "Invalid API key");
  });
});
