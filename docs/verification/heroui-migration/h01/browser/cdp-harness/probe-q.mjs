import puppeteer from "puppeteer-core";
const browser = await puppeteer.launch({ executablePath: process.env.CHROME_PATH ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", headless: true, args: ["--no-first-run"] });
const page = await browser.newPage();
page.on("pageerror", (e) => console.log("PAGEERROR:", e.message.slice(0, 200)));
await page.goto("http://localhost:5199/spike.html", { waitUntil: "networkidle0" });
console.log(JSON.stringify(await page.evaluate(() => ({
  radios: document.querySelectorAll('[role="radio"]').length,
  choices: document.querySelectorAll('[data-slot="questionnaire-choice"]').length,
  hasEmailText: !![...document.querySelectorAll("*")].find((n) => n.children.length === 0 && n.textContent === "Email"),
  menus: document.querySelectorAll("div").length ? undefined : 0,
  contextArea: !![...document.querySelectorAll("div")].find((n) => (n.textContent || "").includes("Right-click me")),
})), null, 1));
await browser.close();
