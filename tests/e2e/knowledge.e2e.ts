import { describe, test } from "@e2e-dev/web";
import { expect } from "e2e";

const knowledgeBaseName = `E2E Knowledge ${Date.now()}`;
let knowledgeBaseId = "";

async function deleteAbandonedKnowledgeBases(
  evaluate: (
    fn: (prefix: string) => Promise<string[]>,
    arg: string,
  ) => Promise<string[]>,
) {
  const deleted = await evaluate(async (prefix) => {
    const response = await fetch("/api/knowledge/kb");
    if (!response.ok) throw new Error(`list failed: ${response.status}`);
    const body = (await response.json()) as {
      items: Array<{ id: string; name: string }>;
    };
    const removed: string[] = [];
    for (const item of body.items) {
      if (!item.name.startsWith(prefix)) continue;
      const deleted = await fetch(`/api/knowledge/kb/${item.id}`, {
        method: "DELETE",
      });
      if (!deleted.ok) throw new Error(`delete failed: ${deleted.status}`);
      removed.push(item.name);
    }
    return removed;
  }, "E2E Knowledge");
  expect(deleted).toEqual(deleted);
}

describe("knowledge", {
  session: "admin",
  serial: true,
  timeout: 240_000,
}, () => {
  test("creates a knowledge base through the form", async ({
    app,
    screen,
    browser,
  }) => {
    await app.open("/admin/knowledge");
    await expect(screen.getByRole("heading", "Knowledge")).toBeVisible();
    await deleteAbandonedKnowledgeBases((fn, arg) => browser.evaluate(fn, arg));

    await screen.getByRole("button", "Create a knowledge base").tap();
    const dialog = screen.getByRole("dialog");
    await expect(
      dialog.getByRole("heading", "Create a knowledge base"),
    ).toBeVisible();
    await expect(dialog.getByRole("button", "Create")).toBeDisabled();

    await dialog.getByLabel("Name").fill(knowledgeBaseName);
    await dialog
      .getByLabel("Description")
      .fill("Created and deleted by the e2e suite.");
    await dialog.getByRole("button", "Advanced settings").tap();
    await expect(dialog.getByLabel("Chunk size")).toHaveValue("512");
    await expect(dialog.getByLabel("Chunk overlap")).toHaveValue("80");
    await dialog.getByRole("button", "Hide advanced settings").tap();
    await dialog.getByRole("button", "Create").tap();

    const row = browser.locator(
      `[data-slot="item"]:has-text(${JSON.stringify(knowledgeBaseName)})`,
    );
    await expect(row).toBeVisible({ timeout: 30_000 });
    await expect(row).toContainText("0 docs");
    knowledgeBaseId =
      /\/admin\/knowledge\/([^/?#]+)/.exec(
        (await row.getByRole("link").getAttribute("href")) ?? "",
      )?.[1] ?? "";
    expect(knowledgeBaseId).not.toBe("");
  });

  test("ingests, searches, and deletes documents", async ({
    app,
    screen,
    browser,
  }) => {
    await app.open(`/admin/knowledge/${knowledgeBaseId}`);
    await expect(screen.getByRole("heading", knowledgeBaseName)).toBeVisible();

    async function addText(title: string, content: string) {
      await screen.getByLabel("Title (optional)").fill(title);
      await screen.getByLabel("Content").fill(content);
      await screen.getByRole("button", "Add").tap();
      await expect(
        browser.locator("tbody tr").filter({ hasText: title }),
      ).toBeVisible({ timeout: 30_000 });
    }

    await addText(
      `${knowledgeBaseName} handbook`,
      "The aurora beacon calibration sequence is complete. Record the final sensor offset before rebooting the station.",
    );
    const handbookRow = browser
      .locator("tbody tr")
      .filter({ hasText: `${knowledgeBaseName} handbook` });
    await expect(handbookRow).toContainText("Completed", { timeout: 180_000 });
    await expect(handbookRow).toContainText(/[1-9]\d* chunks/);

    await screen.getByLabel("Type").first().selectOption("URL");
    await screen.getByLabel("Title (optional)").fill("E2E unreachable URL");
    await screen
      .getByLabel("URL")
      .fill("http://10.255.255.1/openbot-e2e-unreachable");
    await screen.getByRole("button", "Add").tap();
    const failedRow = browser
      .locator("tbody tr")
      .filter({ hasText: "E2E unreachable URL" });
    await expect(failedRow).toContainText("Failed", { timeout: 180_000 });

    await screen.getByLabel("Query").fill("aurora beacon calibration");
    await screen.getByLabel("Top K").fill("1");
    await expect(screen.getByLabel("Top K")).toHaveValue("1");
    await screen.getByRole("button", "Search").tap();
    await expect(
      screen.getByRole("article").filter({ hasText: "handbook" }),
    ).toBeVisible({ timeout: 30_000 });
    await expect(screen.getByText(/^score /).first()).toBeVisible();

    await screen.getByLabel("Type").first().selectOption("Text");
    await addText(
      `${knowledgeBaseName} batch one`,
      "This document exists to exercise two-row selection and bulk deletion.",
    );
    await addText(
      `${knowledgeBaseName} batch two`,
      "This document also exists only for the bulk deletion flow.",
    );
    for (const title of [
      `${knowledgeBaseName} batch one`,
      `${knowledgeBaseName} batch two`,
    ]) {
      await screen.getByRole("checkbox", { name: `Select ${title}` }).check();
    }
    await expect(screen.getByText("2 selected")).toBeVisible();
    await screen.getByRole("button", "Delete 2").tap();
    await expect(screen.getByRole("button", "Delete 2")).toBeHidden({
      timeout: 30_000,
    });
    await expect(
      browser.locator("tbody tr").filter({ hasText: "batch" }),
    ).toHaveCount(0, { timeout: 30_000 });
  });

  test("deletes the knowledge base and rejects its stale detail page", async ({
    app,
    screen,
    browser,
  }) => {
    await app.open("/admin/knowledge");
    const row = browser.locator(
      `[data-slot="item"]:has-text(${JSON.stringify(knowledgeBaseName)})`,
    );
    await expect(row).toBeVisible();
    await row.getByRole("button", { name: "Delete" }).tap();

    const dialog = screen.getByRole("dialog");
    await expect(
      dialog.getByText(
        `Delete the knowledge base “${knowledgeBaseName}” and all of its documents?`,
      ),
    ).toBeVisible();
    await dialog.getByRole("button", "Delete").tap();
    await expect(row).toBeHidden({ timeout: 30_000 });

    await app.open(`/admin/knowledge/${knowledgeBaseId}`);
    await expect(
      screen.getByText("This knowledge base could not be loaded."),
    ).toBeVisible();
  });
});
