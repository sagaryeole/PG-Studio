import { expect, test as base, type Page } from "@playwright/test";

/**
 * Every test fails on an uncaught page error or a console.error. A test that
 * expects a particular error (say, a 404 from a bad link) calls
 * `allowConsoleError(/pattern/)` first.
 */
export const test = base.extend<{ allowConsoleError: (pattern: RegExp) => void }>({
  allowConsoleError: [
    async ({ page }, use) => {
      const problems: string[] = [];
      const allowed: RegExp[] = [];
      page.on("pageerror", (err) => problems.push(`pageerror: ${err.message}`));
      page.on("console", (msg) => {
        if (msg.type() !== "error") return;
        const text = msg.text();
        if (!allowed.some((re) => re.test(text))) problems.push(`console.error: ${text}`);
      });
      await use((pattern) => void allowed.push(pattern));
      expect(problems, "uncaught errors or console.error in the page").toEqual([]);
    },
    { auto: true },
  ],
});

export { expect };

/** Open the app at a URL hash (e.g. "#t=orders") and wait until the sidebar has loaded. */
export async function gotoApp(page: Page, hash = ""): Promise<void> {
  await page.goto(`/${hash}`);
  await expect(page.locator("#tables h3").first()).toBeVisible();
  await expect(page.locator("#schema-label")).not.toHaveText("—");
}

/** Click a table in the sidebar and wait for its rows. */
export async function openTable(page: Page, name: string): Promise<void> {
  await page.locator(`#tables button[title="${name}"]`).click();
  await expect(page.locator("#title")).toHaveText(name);
  await expect(page.locator("#grid tbody tr").first()).toBeVisible();
}

/** Text of the status column for every row on the page (orders table). */
export function columnTexts(page: Page, columnName: string) {
  return page.evaluate((name) => {
    const heads = [...document.querySelectorAll("#grid thead th .nm")].map((n) => n.textContent);
    const idx = heads.indexOf(name);
    if (idx < 0) throw new Error(`no column ${name}`);
    // +1 for the row-number cell
    return [...document.querySelectorAll("#grid tbody tr")].map((tr) => tr.children[idx + 1]?.textContent ?? "");
  }, columnName);
}

/** The hash part of the current URL, decoded. */
export function hashParams(page: Page): URLSearchParams {
  return new URLSearchParams(new URL(page.url()).hash.slice(1));
}

export const DEMO = {
  bookshopId: "demo-bookshop",
  analyticsId: "demo-analytics",
};
