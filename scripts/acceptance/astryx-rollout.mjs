import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { existsSync } from "node:fs";
import { chromium } from "playwright-core";

const edition = process.argv[2];
const outputDir = process.env.ISSUE17_DIR ?? "/tmp/openbot-issue17";
const phase = process.argv[3];
const origin =
  edition === "personal" ? "http://127.0.0.1:34920" : "http://127.0.0.1:34921";
const retired = phase === "retired";
const enabled = phase === "enabled" || retired;
const team = edition === "team";
assert(["personal", "team"].includes(edition));
assert(["before", "enabled", "rollback", "red", "retired"].includes(phase));

const browser = await chromium.launch();
const storageState = `${outputDir}/${edition}-browser.json`;
const context = await browser.newContext({
  storageState:
    phase !== "before" && existsSync(storageState) ? storageState : undefined,
});
const secret = "issue17-loopback-test-secret-never-use-in-production";

async function signIn(target, role) {
  const token = `issue17-${role}-token`;
  const signature = createHmac("sha256", secret).update(token).digest("base64");
  await target.addCookies([
    {
      url: origin,
      name: "better-auth.session_token",
      value: encodeURIComponent(`${token}.${signature}`),
    },
  ]);
}

const report = [];
const page = await context.newPage();
page.setDefaultTimeout(7000);
page.setDefaultNavigationTimeout(10000);
const pageErrors = [];
page.on("pageerror", (error) => pageErrors.push(error.message));

async function go(path, destination, content) {
  await page.goto(origin + path);
  await page.waitForURL((url) => url.pathname + url.search === destination);
  await page.getByText(content, { exact: true }).first().waitFor();
  report.push({ path, destination, content });
}

async function api(target, method, path, data, status) {
  const response = await target.request.fetch(origin + path, { method, data });
  assert.equal(
    response.status(),
    status,
    `${method} ${path}: ${await response.text()}`,
  );
  return response.json();
}

try {
  if (phase === "red") {
    await go("/s/activity", "/s/activity", "Activity");
  } else {
    if (team) await signIn(context, "admin");
    const identity = await api(context, "GET", "/api/me", undefined, 200);
    if (phase !== "before") {
      const { preferences } = await api(
        context,
        "GET",
        "/api/settings/preferences",
        undefined,
        200,
      );
      if (!retired) assert.equal(preferences.skin, "openmuse");
      report.push({ restoredSkin: preferences.skin });
    }
    assert.equal(identity.user.role, "admin");
    const label = `Issue 17 ${edition} Bot`;
    if (phase === "before") {
      await page.goto(`${origin}/bots`);
      const { agents } = await api(
        context,
        "GET",
        "/api/agents",
        undefined,
        200,
      );
      const agent =
        agents.find(({ name }) => name === label) ??
        (
          await api(
            context,
            "POST",
            "/api/agents",
            {
              name: label,
              title: "",
              roleDescription: "Fixture for deployment rehearsal",
              visibility: "private",
            },
            201,
          )
        ).agent;
      const { channels } = await api(
        context,
        "GET",
        "/api/channels",
        undefined,
        200,
      );
      if (!channels.some(({ agentIds }) => agentIds.includes(agent.id))) {
        await api(
          context,
          "POST",
          "/api/channels",
          { agentIds: [agent.id] },
          201,
        );
      }
      await page
        .waitForResponse(
          (response) => response.url().includes("/api/components/catalogue"),
          { timeout: 2500 },
        )
        .catch(() => {});
      const { components } = await api(
        context,
        "GET",
        "/api/components",
        undefined,
        200,
      );
      const draft = components[0];
      assert(draft, "missing built-in Component");
      await api(
        context,
        "PUT",
        `/api/components/${draft.name}/draft`,
        {
          description: `Issue 17 ${edition} saved component draft`,
        },
        200,
      );
    }
    const { agents } = await api(context, "GET", "/api/agents", undefined, 200);
    const bot = agents.find(({ name }) => name === label);
    assert(bot);
    const { channels } = await api(
      context,
      "GET",
      "/api/channels",
      undefined,
      200,
    );
    const conversation = channels.find(({ agentIds }) =>
      agentIds.includes(bot.id),
    );
    assert(conversation);
    const { components } = await api(
      context,
      "GET",
      "/api/components",
      undefined,
      200,
    );
    const draftText = `Issue 17 ${edition} saved component draft`;
    const persistedDraft = components.find(
      ({ draftDescription }) => draftDescription === draftText,
    );
    assert(persistedDraft);
    assert.notEqual(persistedDraft.publishedDescription, draftText);

    // Use the same origin and browser storage when the harness switches the deployed bundle.
    await page.goto(`${origin}/bots`);
    if (phase !== "before") {
      assert.equal(
        await page.evaluate(() => localStorage.getItem("openbot-theme")),
        "dark",
      );
      await page.waitForFunction(() =>
        document.documentElement.classList.contains("dark"),
      );
      report.push({ restoredTheme: "dark" });
    }
    const profiles = ["openbot", "openduet", "opendots", "openmuse"];
    if (retired && team) {
      for (const skin of profiles) {
        const account = await browser.newContext();
        try {
          await signIn(account, skin);
          const { user } = await api(account, "GET", "/api/me", undefined, 200);
          assert.equal(user.id, `issue17-${skin}`);
          const { preferences } = await api(
            account,
            "GET",
            "/api/settings/preferences",
            undefined,
            200,
          );
          assert.equal(preferences.skin, skin);
          const signedIn = await account.newPage();
          await signedIn.goto(`${origin}/bots`);
          await signedIn.locator(".astryx-web-shell").waitFor();
          await signedIn
            .getByRole("heading", { name: "Bots", exact: true })
            .waitFor();
          assert.equal(await signedIn.locator("html[data-skin]").count(), 0);
          report.push({ account: user.id, savedSkin: skin, shell: "Astryx" });
        } finally {
          await account.close();
        }
      }
    }
    for (const skin of profiles) {
      await api(context, "PATCH", "/api/settings/preferences", { skin }, 200);
      if (retired) {
        await page.evaluate(
          (value) => localStorage.setItem("openbot-skin", value),
          skin,
        );
      }
      await go("/bots", "/bots", label);
      if (retired) {
        const { preferences } = await api(
          context,
          "GET",
          "/api/settings/preferences",
          undefined,
          200,
        );
        assert.equal(preferences.skin, skin);
        assert.equal(await page.locator("html[data-skin]").count(), 0);
      } else {
        await page.waitForFunction(
          (value) => localStorage.getItem("openbot-skin") === value,
          skin,
        );
      }
      assert.equal(
        (await page.locator(".astryx-web-shell").count()) > 0,
        enabled,
      );
      report.push({ skin, shell: enabled ? "Astryx" : "legacy" });
      if (!enabled) {
        if (skin === "openduet") await go("/s/tasks", "/s/tasks", "Tasks");
        if (skin === "opendots") {
          await go("/s/routines", "/s/routines", "Routines");
          if (team) await go("/s/memories", "/s/memories", "Memories");
        }
        if (skin === "openmuse") {
          await go("/s/activity", "/s/activity", "Activity");
          await go("/s/ideas", "/s/ideas", "Ideas");
          await go("/s/goals", "/s/goals", "Goals");
        }
      }
    }
    await api(
      context,
      "PATCH",
      "/api/settings/preferences",
      { skin: "openbot" },
      200,
    );
    for (const theme of ["light", "dark"]) {
      await page.evaluate(
        (value) => localStorage.setItem("openbot-theme", value),
        theme,
      );
      await go(`/agents?agent=${bot.id}`, `/bots/${bot.id}`, label);
      assert.equal(
        await page
          .locator("html")
          .evaluate((element) => element.classList.contains("dark")),
        theme === "dark",
      );
      assert.equal(
        (await page.locator(".astryx-web-shell").count()) > 0,
        enabled,
      );
      await page
        .getByText("Northstar QA", { exact: true })
        .filter({ visible: true })
        .first()
        .waitFor();
      if (enabled) {
        const brand = page
          .locator(".astryx-brand")
          .filter({ hasText: "Northstar QA", visible: true })
          .first();
        await brand.waitFor();
        assert.equal(
          await brand.locator("img").getAttribute("src"),
          "/issue17-brand.svg",
        );
        await brand.locator("img").evaluate((img) => img.decode());
        const accent = await page
          .locator(".astryx-brand")
          .first()
          .evaluate(
            (element, appearance) =>
              getComputedStyle(element)
                .getPropertyValue(`--pilot-accent-${appearance}`)
                .trim(),
            theme,
          );
        assert.equal(accent, theme === "dark" ? "#9bd0ff" : "#245589");
      }
      report.push({
        theme,
        brand: "Northstar QA",
        customMarkAndAccent: enabled,
      });
    }

    if (retired) {
      await go("/settings", "/settings", "Appearance");
      assert.equal(await page.getByLabel("Skin", { exact: true }).count(), 0);
      assert.equal(
        await page.getByText("OpenDuet", { exact: true }).count(),
        0,
      );
      const toggle = page.getByRole("switch", { name: "Dark theme" });
      await toggle.click();
      await page.waitForFunction(
        () =>
          !document.documentElement.classList.contains("dark") &&
          localStorage.getItem("openbot-theme") === "light",
      );
      await toggle.click();
      await page.waitForFunction(
        () =>
          document.documentElement.classList.contains("dark") &&
          localStorage.getItem("openbot-theme") === "dark",
      );
      report.push({
        themeControl: "light and dark persist",
        skinPicker: "absent",
      });
    }

    await context.storageState({ path: storageState });
    await go(
      `/channel/${conversation.id}`,
      `/channel/${conversation.id}`,
      label,
    );
    await go(
      `/channel/new?agent=${bot.id}`,
      `/channel/new?agent=${bot.id}`,
      label,
    );
    const editor = page.getByRole("textbox", { name: "Message" });
    await editor.fill("Issue 17 unsent composer probe");
    assert.match(await editor.innerText(), /Issue 17 unsent composer probe/);
    await page.reload();
    await editor.waitFor();
    const retainedUnsentText = (await editor.innerText()).includes(
      "Issue 17 unsent composer probe",
    );
    report.push({ unsentComposerTextSurvivesReload: retainedUnsentText });
    if (enabled && retired) {
      const other = (
        await api(
          context,
          "POST",
          "/api/agents",
          {
            name: `Issue 18 ${edition} Other Bot`,
            title: "",
            roleDescription: "Fixture for Bot context changes",
            visibility: "private",
          },
          201,
        )
      ).agent;
      await go(`/bots/${other.id}`, `/bots/${other.id}`, other.name);
      await page
        .getByRole("navigation", { name: "Main navigation" })
        .getByRole("link", { name: "Goals", exact: true })
        .click();
      await page.waitForURL(
        (url) => url.pathname + url.search === "/responsibilities?view=goals",
      );
      await page
        .getByText(`Review ongoing work for ${other.name}.`, { exact: true })
        .waitFor();
      await go(
        `/channel/${conversation.id}`,
        `/channel/${conversation.id}`,
        label,
      );
      await go("/s/activity", "/s/activity", "Activity");
      await page
        .getByText(`Review activity for ${label}.`, { exact: true })
        .waitFor();
      report.push({
        botContext: "profile to Goals and one-to-one Conversation to Activity",
      });
    }
    if (enabled) {
      if (!retired)
        await page.evaluate(
          ({ userId, botId }) =>
            localStorage.setItem(`openmuse-bot:${userId}`, botId),
          { userId: identity.user.id, botId: bot.id },
        );
      for (const [source, dest, content] of [
        ["/s/tasks", "/tasks", "Bot tasks"],
        ...(retired ? [["/s/unknown", "/", "Browse Bots"]] : []),
        ["/s/routines", "/routines", "Routines"],
        [
          "/s/memories",
          team ? "/capabilities/memory" : "/bots",
          team ? "Memory" : "Bots",
        ],
        ["/s/activity", "/s/activity", "Activity"],
        ["/s/ideas", "/ideas", "Ideas"],
        ["/s/goals", "/responsibilities?view=goals", "Goals"],
        ["/group/new", "/channel/new", "To:"],
        ["/agents", "/bots", "Bots"],
        ["/team-bots", "/bots", "Bots"],
        ["/skills", "/capabilities/skills", "Skills"],
        ["/capabilities", "/capabilities/skills", "Skills"],
        [
          "/memory",
          team ? "/capabilities/memory" : "/bots",
          team ? "Memory" : "Bots",
        ],
        [
          "/settings/memory",
          team ? "/capabilities/memory" : "/bots",
          team ? "Memory" : "Bots",
        ],
        ["/approvals", "/settings/approvals", "Approvals"],
        ["/reachability", "/settings/notifications", "Notifications"],
        ["/settings/connected-accounts", "/connections", "Connections"],
      ])
        await go(source, dest, content);
      for (const source of [
        "/settings/connected-accounts/parallel",
        `/connections/parallel/bots/${bot.id}`,
        "/connections/parallel/tools/search",
        ...(team
          ? []
          : ["/settings/plugins/parallel", "/admin/plugins/parallel"]),
      ]) {
        await go(source, "/connections/parallel", "Parallel Search");
      }
      await go(
        "/settings/connected-accounts/parallel?action=search",
        "/connections/parallel?action=search",
        "Parallel Search",
      );
      await go("/s/activity", "/s/activity", `View ${label}`);
      await page.setViewportSize({ width: 390, height: 844 });
      await go("/bots", "/bots", "Bots");
      const nav = page.getByRole("button", { name: "Open navigation" });
      await nav.focus();
      await page.keyboard.press("Enter");
      await page.getByRole("button", { name: "Close navigation" }).waitFor();
      await page.keyboard.press("Escape");
      await nav.waitFor();
      await page.waitForFunction(
        () =>
          document.activeElement?.getAttribute("aria-label") ===
          "Open navigation",
      );
      report.push({
        narrowKeyboardNavigation:
          "opened with Enter and closed with Escape, focus restored",
      });
      await page.setViewportSize({ width: 1280, height: 720 });
      await page.goto(`${origin}/agents?new=true`);
      await page.waitForURL(
        (url) => url.pathname === "/bots" && url.search === "?new=true",
      );
      await page.getByRole("dialog").waitFor();
      report.push({
        path: "/agents?new=true",
        destination: "/bots?new=true",
        content: "Create Bot dialog",
      });
      if (retired) {
        const createdLabel = `Issue 18 ${edition} ${Date.now()}`;
        const dialog = page.getByRole("dialog", { name: "New Bot" });
        await dialog.getByLabel("Name", { exact: true }).fill(createdLabel);
        await dialog.getByRole("button", { name: "Create Bot" }).click();
        await page.waitForURL((url) => /^\/bots\/[^/]+$/.test(url.pathname));
        await page.getByText(createdLabel, { exact: true }).first().waitFor();
        const { agents } = await api(
          context,
          "GET",
          "/api/agents",
          undefined,
          200,
        );
        assert(agents.some(({ name }) => name === createdLabel));
        report.push({
          createdBot: createdLabel,
          destination: new URL(page.url()).pathname,
        });
        await go("/bots", "/bots", createdLabel);
      }
    }
    if (team) {
      await page.goto(`${origin}/admin/enterprise`);
      await page.waitForURL((url) => /^\/admin\/?$/.test(url.pathname));
      report.push({ path: "/admin/enterprise", destination: "/admin" });
      await page.goto(`${origin}/admin/components/${persistedDraft.name}`);
      await page.getByText(draftText, { exact: true }).waitFor();
      report.push({
        path: `/admin/components/${persistedDraft.name}`,
        content: draftText,
      });
      const member = await browser.newContext();
      await signIn(member, "member");
      const who = await api(member, "GET", "/api/me", undefined, 200);
      assert.equal(who.user.role, "user");
      await api(member, "GET", `/api/agents/${bot.id}`, undefined, 404);
      await api(member, "GET", "/api/admin/people", undefined, 403);
      report.push({ memberPrivateBot: 404, memberAdminAPI: 403 });
      const memberPage = await member.newPage();
      await memberPage.goto(`${origin}/admin`);
      await memberPage.waitForURL((url) => url.pathname === "/");
      await member.close();
    } else {
      await page.goto(`${origin}/admin/audit`);
      await page.waitForURL((url) => url.pathname === "/settings/activity");
      report.push({ path: "/admin/audit", destination: "/settings/activity" });
    }
    await api(
      context,
      "PATCH",
      "/api/settings/preferences",
      { skin: "openmuse" },
      200,
    );
    report.push({
      bot: bot.id,
      conversation: conversation.id,
      draft: draftText,
      authorization: team ? "admin and member" : "Personal admin",
    });
  }
  assert.deepEqual(pageErrors, []);
  console.log(JSON.stringify({ edition, phase, checks: report }, null, 2));
} catch (error) {
  console.error({
    edition,
    phase,
    url: page.url(),
    checks: report,
    body: (await page.locator("body").innerText()).slice(0, 2200),
    pageErrors,
  });
  throw error;
} finally {
  await browser.close();
}
