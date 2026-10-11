import { describe, expect, test } from "bun:test";
import { createKnowledgeCircuit } from "./circuit";

/** 可拨动的假时钟：测试冷却窗口不必真等 30 秒。 */
function fakeClock(start = 0) {
  let now = start;
  return {
    now: () => now,
    advance: (ms: number) => {
      now += ms;
    },
  };
}

describe("knowledge circuit", () => {
  test("stays closed below the failure threshold", () => {
    const circuit = createKnowledgeCircuit();
    expect(circuit.state()).toBe("closed");
    expect(circuit.allow()).toBe(true);

    circuit.recordFailure();
    circuit.recordFailure();
    expect(circuit.state()).toBe("closed");
    expect(circuit.allow()).toBe(true);
  });

  test("opens after the threshold of consecutive failures", () => {
    const circuit = createKnowledgeCircuit();
    for (let i = 0; i < 3; i += 1) circuit.recordFailure();
    expect(circuit.state()).toBe("open");
    expect(circuit.allow()).toBe(false);
  });

  test("a success resets the consecutive-failure count", () => {
    const circuit = createKnowledgeCircuit();
    circuit.recordFailure();
    circuit.recordFailure();
    circuit.recordSuccess();
    circuit.recordFailure();
    circuit.recordFailure();
    // 2 次失败 + 成功清零 + 再 2 次失败：未达阈值，仍 closed。
    expect(circuit.state()).toBe("closed");
    expect(circuit.allow()).toBe(true);
  });

  test("half-opens after cooldown and admits exactly one probe", () => {
    const clock = fakeClock();
    const circuit = createKnowledgeCircuit({ now: clock.now });
    for (let i = 0; i < 3; i += 1) circuit.recordFailure();
    expect(circuit.state()).toBe("open");

    clock.advance(30_001);
    expect(circuit.state()).toBe("half-open");
    expect(circuit.allow()).toBe(true);
    // 探测在途：其余调用仍被拒，避免半开期把流量全部放出去。
    expect(circuit.allow()).toBe(false);
    expect(circuit.allow()).toBe(false);
  });

  test("a successful probe closes the circuit and clears the probe slot", () => {
    const clock = fakeClock();
    const circuit = createKnowledgeCircuit({ now: clock.now });
    for (let i = 0; i < 3; i += 1) circuit.recordFailure();
    clock.advance(30_001);
    expect(circuit.allow()).toBe(true);
    circuit.recordSuccess();
    expect(circuit.state()).toBe("closed");
    expect(circuit.allow()).toBe(true);
  });

  test("a failed probe re-opens the circuit for another cooldown window", () => {
    const clock = fakeClock();
    const circuit = createKnowledgeCircuit({ now: clock.now });
    for (let i = 0; i < 3; i += 1) circuit.recordFailure();
    clock.advance(30_001);
    expect(circuit.allow()).toBe(true);
    circuit.recordFailure();
    expect(circuit.state()).toBe("open");
    expect(circuit.allow()).toBe(false);
    // 冷却再次过去后又回到 half-open 可探测。
    clock.advance(30_001);
    expect(circuit.state()).toBe("half-open");
    expect(circuit.allow()).toBe(true);
  });

  test("honours injected threshold and cooldown options", () => {
    const clock = fakeClock();
    const circuit = createKnowledgeCircuit({
      failureThreshold: 1,
      cooldownMs: 1_000,
      now: clock.now,
    });
    circuit.recordFailure();
    expect(circuit.state()).toBe("open");
    expect(circuit.allow()).toBe(false);
    clock.advance(1_000);
    expect(circuit.state()).toBe("half-open");
  });
});
