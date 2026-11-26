import { expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { chromium } from "playwright";
import { uploadFromBrowser } from "../src/browser-upload";

test.skipIf(!existsSync(chromium.executablePath()))(
  "browser uploads the single file with its session and stops at redirects or changed control",
  async () => {
    const browser = await chromium.launch({ channel: "chromium" });
    try {
      const page = await browser.newPage();
      const origin = "https://upload.example.test";
      const input = {
        url: `${origin}/upload`,
        field: "attachment",
        name: "report.csv",
        content: "YSxiCg==",
      };
      const posts: string[] = [];
      let redirect = false;
      await page.context().route("**/*", async (route) => {
        const request = route.request();
        if (request.isNavigationRequest()) {
          await route.fulfill({
            body: "<title>Upload fixture</title>",
            contentType: "text/html",
          });
        } else {
          posts.push(request.url());
          expect(request.method()).toBe("POST");
          expect((await request.allHeaders()).cookie).toBe("session=fixture");
          expect(request.postData()).toContain(
            'name="attachment"; filename="report.csv"',
          );
          expect(request.postData()).toContain("a,b\n");
          await route.fulfill(
            redirect
              ? {
                  status: 307,
                  headers: {
                    location: "https://elsewhere.example.test/receive",
                  },
                }
              : { status: 201 },
          );
        }
      });
      await page
        .context()
        .addCookies([{ name: "session", value: "fixture", url: origin }]);
      await page.goto(origin);
      expect(await uploadFromBrowser(page, input, () => false)).toMatchObject({
        status: "not_sent",
      });
      expect(
        await uploadFromBrowser(
          page,
          { ...input, url: "https://elsewhere.example.test/upload" },
          () => true,
        ),
      ).toMatchObject({ status: "not_sent" });
      expect(posts).toEqual([]);
      expect(await uploadFromBrowser(page, input, () => true)).toEqual({
        status: "accepted",
        httpStatus: 201,
      });
      redirect = true;
      expect(await uploadFromBrowser(page, input, () => true)).toMatchObject({
        status: "unknown",
      });
      expect(posts).toEqual([input.url, input.url]);
    } finally {
      await browser.close();
    }
  },
  15_000,
);
