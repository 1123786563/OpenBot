import { describe, expect, test } from "bun:test";
import { parseGatewayEndpointInput } from "../src/gateway/config-store";

describe("parseGatewayEndpointInput", () => {
  test("accepts a bare https origin", () => {
    const r = parseGatewayEndpointInput({ baseUrl: "https://bifrost.example.com", requestTimeoutMs: 10_000 });
    expect(r).toEqual({ ok: true, value: { baseUrl: "https://bifrost.example.com", requestTimeoutMs: 10_000 } });
  });
  test("rejects empty / blank", () => {
    for (const baseUrl of ["", "   "]) {
      expect(parseGatewayEndpointInput({ baseUrl, requestTimeoutMs: 10_000 })).toEqual({
        ok: false, error: "Gateway base URL is required.",
      });
    }
  });
  test("rejects non-http(s) protocols", () => {
    expect(parseGatewayEndpointInput({ baseUrl: "ftp://bifrost.example.com", requestTimeoutMs: 10_000 })).toEqual({
      ok: false, error: "Gateway base URL must be an http or https URL.",
    });
  });
  test("rejects credentials in the URL", () => {
    expect(parseGatewayEndpointInput({ baseUrl: "https://user:pw@bifrost.example.com", requestTimeoutMs: 10_000 })).toEqual({
      ok: false, error: "Gateway base URL must not carry credentials.",
    });
  });
  test("rejects path, query, or fragment", () => {
    for (const baseUrl of ["https://bifrost.example.com/v1", "https://bifrost.example.com?a=1", "https://bifrost.example.com#f"]) {
      expect(parseGatewayEndpointInput({ baseUrl, requestTimeoutMs: 10_000 })).toEqual({
        ok: false, error: "Gateway base URL must be the origin only, without a path, query or fragment.",
      });
    }
  });
  test("rejects a non-positive or non-integer timeout", () => {
    for (const requestTimeoutMs of [0, -1, 2.5]) {
      expect(parseGatewayEndpointInput({ baseUrl: "https://bifrost.example.com", requestTimeoutMs })).toEqual({
        ok: false, error: "requestTimeoutMs must be a whole number of milliseconds greater than zero.",
      });
    }
  });
});
