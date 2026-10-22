import "./preload";
import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  test,
} from "../../tests/support/bun-test-compat";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { cleanup, render } from "@testing-library/react";
import i18n from "@/lib/i18n";
import { settleReactWork } from "./settle-react-work";
import type { GatewayAudioPathAvailability } from "@/lib/gateway/queries";

/*
 * Ticket 14.4 — the audio path availability rows, the UI half of "未验证音频路径保持不可用":
 * an administrator who cannot call a path must be told WHICH evidence item is missing, not
 * merely that the path failed.
 *
 *   AC-1  an unverified path renders the not-available state AND one sentence per missing
 *         evidence item, drawn from the registry's own closed code set — the reason points
 *         at the specific missing item;
 *   AC-2  a checked absence (separation/enhancement) renders "not an entrance on this
 *         gateway" — a different sentence from a gap, because it is a different fact;
 *   AC-3  an enableable path renders the available state and NO reason block — no
 *         misleading missing-evidence line on a usable path;
 *   AC-4  the per-ref basis rollup names the unpriced dimensions of a basis-blocked path,
 *         so the administrator knows the gap is pricing, not structure.
 */

const { AudioPathAvailability } = await import(
  "@/components/gateway/audio-path-availability"
);

beforeAll(async () => {
  GlobalRegistrator.register();
  await i18n.changeLanguage("zh-CN");
});

afterEach(() => cleanup());

afterAll(async () => {
  await settleReactWork();
  await i18n.changeLanguage("en");
  GlobalRegistrator.unregister();
});

/** The registry-shaped rows the status answer carries, in the shapes the fixtures pin. */
function row(
  overrides: Partial<GatewayAudioPathAvailability>,
): GatewayAudioPathAvailability {
  return {
    path: "/v1/audio/translations",
    family: "translation",
    stream: false,
    exists: true,
    missingItems: [],
    bases: [],
    ...overrides,
  };
}

describe("Bifrost 14.4 (#313): capability availability rows", () => {
  test("an unverified path shows not-available and one sentence per missing evidence item", () => {
    const view = render(
      <AudioPathAvailability
        paths={[
          row({
            missingItems: [
              {
                code: "no_input_meter_wired",
                detail: "14.1's duration meter is wired to the transcription path only",
              },
              {
                code: "no_admission_wiring",
                detail: "the gateway carries this path as a passthrough billing reference only",
              },
              {
                code: "no_wire_price_source",
                detail: "the v1 pricing object carries no audio_input field",
              },
            ],
          }),
        ]}
      />,
    );

    const rowEl = view.getByTestId("audio-path-/v1/audio/translations-unary");
    expect(rowEl.textContent).toContain("/v1/audio/translations");
    expect(view.getByTestId("audio-path-state").textContent).toBe("不可用");

    // AC-1: the reason points at the SPECIFIC missing evidence items — one sentence each,
    // from the locale's closed code set.
    const missing = view.getAllByTestId("audio-path-missing");
    expect(missing).toHaveLength(3);
    expect(missing.map((node) => node.textContent)).toEqual([
      "该路径未接入服务端可信的输入计量",
      "不存在可准入该路径的 Reserve/Settle 接线",
      "该路径计费的维度在协议上无价格来源",
    ]);
  });

  test("a checked absence is 'not an entrance' — a different sentence from a gap", () => {
    const view = render(
      <AudioPathAvailability
        paths={[
          row({
            path: "audio/separation-enhancement",
            family: "separation-enhancement",
            exists: false,
          }),
        ]}
      />,
    );
    expect(view.getByTestId("audio-path-state").textContent).toBe(
      "本网关无此入口",
    );
    // A non-entrance has no gap block: there is nothing to fix, the route does not exist.
    expect(view.queryAllByTestId("audio-path-missing")).toHaveLength(0);
  });

  test("an enableable path shows available with no reason block, and its basis line", () => {
    const view = render(
      <AudioPathAvailability
        paths={[
          row({
            path: "/v1/audio/transcriptions",
            family: "recognition",
            missingItems: [],
            bases: [{ ref: "openai|whisper-1|transcription", enableable: true, missingDimensions: [] }],
          }),
        ]}
      />,
    );
    expect(view.getByTestId("audio-path-state").textContent).toBe("可用");
    expect(view.queryAllByTestId("audio-path-missing")).toHaveLength(0);
    expect(
      view.getByTestId("audio-path-/v1/audio/transcriptions-unary").textContent,
    ).toContain("openai|whisper-1|transcription：已为该路径定价");
  });

  test("a structurally complete but basis-blocked path names the unpriced dimensions", () => {
    const view = render(
      <AudioPathAvailability
        paths={[
          row({
            path: "/v1/audio/speech",
            family: "synthesis",
            missingItems: [],
            bases: [
              {
                ref: "openai|tts-1|speech",
                enableable: false,
                missingDimensions: [
                  { dimension: "audio_output", reason: "price_dim_no_source" },
                ],
              },
            ],
          }),
        ]}
      />,
    );
    expect(view.getByTestId("audio-path-state").textContent).toBe("不可用");
    expect(view.queryAllByTestId("audio-path-missing")).toHaveLength(0);
    expect(
      view.getByTestId("audio-path-/v1/audio/speech-unary").textContent,
    ).toContain("audio_output");
  });

  test("a stream variant carries its marker — the entrance's identity, with the path", () => {
    const view = render(<AudioPathAvailability paths={[row({ stream: true })]} />);
    expect(
      view.getByTestId("audio-path-/v1/audio/translations-stream").textContent,
    ).toContain("流式");
  });
});
