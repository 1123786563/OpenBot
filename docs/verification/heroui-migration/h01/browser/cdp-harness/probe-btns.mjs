import puppeteer from "puppeteer-core";
const browser = await puppeteer.launch({ executablePath: process.env.CHROME_PATH ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", headless: true, args: ["--no-first-run"] });
const page = await browser.newPage();
await page.goto("http://localhost:5199/spike.html", { waitUntil: "networkidle0" });
const btns = await page.evaluate(() => [...document.querySelectorAll("button")].map(b => ({ id: b.id, text: (b.textContent||"").trim().slice(0,30), slots: b.getAttribute("data-slot") })));
console.log(JSON.stringify(btns, null, 1));
await browser.close();
