// Probe (fix2): ReadableStream + Response reader interplay under Bun —
// does reader.read() drive the source, and does cancel() reach cancel()?
let cancelled = false;
const stream = new ReadableStream<Uint8Array>({
  async start(controller) {
    const encoder = new TextEncoder();
    controller.enqueue(encoder.encode("probe\n"));
    for (let i = 0; i < 3; i += 1) {
      for (let size = controller.desiredSize; size !== null && size <= 0; size = controller.desiredSize) {
        console.log("backpressure wait, desiredSize =", size);
        await new Promise((r) => setTimeout(r, 25));
      }
      console.log("emitting frame", i, "desiredSize pre =", controller.desiredSize);
      controller.enqueue(encoder.encode(`frame-${i}\n`));
    }
    try { controller.close(); } catch { console.log("close threw"); }
  },
  cancel() { cancelled = true; console.log("SOURCE CANCELLED"); },
});
const response = new Response(stream, { headers: { "content-type": "text/event-stream" } });
console.log("body is same object:", (response.body as unknown) === stream);
const reader = response.body!.getReader();
const probe = await reader.read();
console.log("probe read:", new TextDecoder().decode(probe.value));
await new Promise((r) => setTimeout(r, 100));
const f0 = await reader.read();
console.log("frame read:", new TextDecoder().decode(f0.value));
await reader.cancel();
await new Promise((r) => setTimeout(r, 50));
console.log("cancelled flag:", cancelled);
