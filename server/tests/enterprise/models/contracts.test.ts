import { describe, expect, test } from "bun:test";
import {
  createStaticTargetRegistry,
  type ModelRoute,
  ModelRouteRefViewSchema,
  ModelRouteSchema,
  routeRefOf,
} from "../../../src/enterprise/models/contracts";

/*
 * E4-A 模型路由数据合同（03 分册 §8.1）。
 *
 * ModelRoute 是 §4.1 route 行的严格 Schema：解析后的路由值只能携带批准行上的
 * 字段加部署 registry 中的目标引用（target_ref）。接口层绝不接受模型生成的
 * endpoint、headers、credential_ref——上游目标的真实地址与密钥只存在于部署
 * registry，由 TS 模型代理在拨号前解析（E4-C），任何把端点或凭证字段塞进路由
 * 对象的尝试都必须被 strict 解析拒绝，而不是被静默裁剪。
 *
 * 对外只暴露 route_ref：Go 与其他执行组件永远只见这个引用（验收第 5 条的合同
 * 半场——序列化后的路由对象里不存在密钥或端点字段）。
 *
 * 金额、token 上限与 revision 沿用 run-contracts 的 Decimal 十进制字符串合同：
 * bigint 不经 number 往返。
 */

/** A complete, approved route row in DTO shape; every test mutates from here. */
const route: ModelRoute = {
  tenant_id: "tenant-a",
  id: "route-a1",
  alias: "chat",
  revision: "1",
  resource_id: "resource-a",
  target_ref: "higress/openai-main",
  price_revision: "1",
  currency: "USD",
  input_unit_micros: "10",
  output_unit_micros: "30",
  per_request_micros: "0",
  max_input_tokens: "8192",
  max_output_tokens: "2048",
  max_request_bytes: "262144",
  protocol_profile: "openai-chat",
  usage_profile: "tokens",
  is_default_for_alias: true,
  status: "active",
  created_at: "2026-10-10T00:00:00.000Z",
};

describe("the model route contract is the approved row, strictly", () => {
  test("a complete approved route row parses field for field", () => {
    const parsed = ModelRouteSchema.parse(route);
    expect(parsed).toEqual(route);
  });

  test("no connection or credential field is assignable to a route", () => {
    /* §8.1：接口不能接受模型生成的 endpoint、headers 或 credential_ref。
     * 上游地址/密钥属于部署 registry 与 TS 代理，路由对象里出现即拒绝。 */
    for (const forbidden of [
      "endpoint",
      "base_url",
      "upstream_url",
      "headers",
      "credential_ref",
      "credentials",
      "api_key",
      "authorization",
      "secret",
      "retry",
      "fallback_route",
    ]) {
      expect(
        ModelRouteSchema.safeParse({ ...route, [forbidden]: "x" }).success,
        forbidden,
      ).toBe(false);
    }
    expect(
      ModelRouteSchema.safeParse({
        ...route,
        headers: { authorization: "Bearer x" },
      }).success,
    ).toBe(false);
  });

  test("serializing a route never reveals a secret or an endpoint key", () => {
    /* 验收第 5 条（响应不返回密钥或 endpoint）的合同半场：解析后的路由值
     * 序列化成 JSON 后不存在任何端点/凭证形状的键。 */
    const serialized = JSON.stringify(ModelRouteSchema.parse(route));
    expect(serialized).not.toMatch(
      /"(endpoint|base_url|upstream_url|headers?|credential_ref|api_key|secret|token|authorization)"/i,
    );
  });

  test("bigint counters travel as decimal strings", () => {
    expect(
      ModelRouteSchema.safeParse({ ...route, revision: "-1" }).success,
    ).toBe(false);
    expect(
      ModelRouteSchema.safeParse({ ...route, revision: "1e5" }).success,
    ).toBe(false);
    expect(
      ModelRouteSchema.safeParse({ ...route, price_revision: "1.5" }).success,
    ).toBe(false);
    expect(
      ModelRouteSchema.safeParse({ ...route, input_unit_micros: "01" }).success,
    ).toBe(false);
    expect(
      ModelRouteSchema.safeParse({ ...route, max_output_tokens: "0" }).success,
    ).toBe(true);
  });

  test("the status set is exactly active/disabled", () => {
    expect(
      ModelRouteSchema.safeParse({ ...route, status: "retired" }).success,
    ).toBe(false);
    expect(
      ModelRouteSchema.safeParse({ ...route, status: "disabled" }).success,
    ).toBe(true);
  });

  test("the alias and identifiers follow the bounded ID shape", () => {
    expect(
      ModelRouteSchema.safeParse({ ...route, alias: "bad alias!" }).success,
    ).toBe(false);
    expect(
      ModelRouteSchema.safeParse({ ...route, id: "x".repeat(129) }).success,
    ).toBe(false);
  });

  test("the target reference is a bounded registry key, not a URL", () => {
    expect(
      ModelRouteSchema.safeParse({
        ...route,
        target_ref: "higress/openai-main",
      }).success,
    ).toBe(true);
    expect(
      ModelRouteSchema.safeParse({ ...route, target_ref: "" }).success,
    ).toBe(false);
    expect(
      ModelRouteSchema.safeParse({ ...route, target_ref: "x".repeat(129) })
        .success,
    ).toBe(false);
  });
});

describe("the route reference is the only identity a consumer sees", () => {
  test("routeRefOf projects exactly the route_ref field", () => {
    expect(routeRefOf(route)).toEqual({ route_ref: "route-a1" });
    expect(ModelRouteRefViewSchema.safeParse(routeRefOf(route)).success).toBe(
      true,
    );
  });

  test("the reference view is strict: no alias, no target, no pricing leaks through", () => {
    for (const extra of [
      { alias: "chat" },
      { target_ref: "higress/openai-main" },
      { input_unit_micros: "10" },
      { endpoint: "https://api.example.invalid" },
    ]) {
      expect(
        ModelRouteRefViewSchema.safeParse({ route_ref: "route-a1", ...extra })
          .success,
        JSON.stringify(extra),
      ).toBe(false);
    }
  });
});

describe("the deployment registry owns the target reference", () => {
  test("a registered reference answers yes, an unknown one no", () => {
    const registry = createStaticTargetRegistry([
      "higress/openai-main",
      "higress/openai-alt",
    ]);
    expect(registry.has("higress/openai-main")).toBe(true);
    expect(registry.has("higress/unregistered-target")).toBe(false);
  });

  test("the static registry refuses an empty or unbounded reference", () => {
    const registry = createStaticTargetRegistry(["higress/main"]);
    expect(registry.has("")).toBe(false);
    expect(registry.has("x".repeat(129))).toBe(false);
  });
});
