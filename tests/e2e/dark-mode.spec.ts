import { expect, gotoApp, openTable, test } from "./fixtures";

/** Relative luminance (0 black .. 1 white) of an "rgb(r, g, b)" / "rgba(...)" string. */
function luminance(color: string): number {
  const m = /rgba?\((\d+),\s*(\d+),\s*(\d+)/.exec(color);
  if (!m) throw new Error(`unexpected color ${color}`);
  const [r, g, b] = [m[1], m[2], m[3]].map((v) => {
    const c = Number(v) / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  }) as [number, number, number];
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

const background = (page: import("@playwright/test").Page, selector: string) =>
  page.locator(selector).evaluate((n) => getComputedStyle(n).backgroundColor);

test.describe("color scheme", () => {
  test.describe("dark", () => {
    test.use({ colorScheme: "dark" });

    test("the page and the filter panel use the dark palette", async ({ page }) => {
      await gotoApp(page);
      expect(luminance(await background(page, "body"))).toBeLessThan(0.1);

      await openTable(page, "orders");
      await page.keyboard.press("f");
      const panel = page.locator("#filter-panel");
      await expect(panel).toBeVisible();
      expect(luminance(await background(page, "#filter-panel"))).toBeLessThan(0.1);
      await expect(panel.locator(".fp-foot")).toHaveCSS("display", "flex");
      await expect(panel.locator(".fp-row")).toHaveCSS("display", "grid");
      // Text stays readable against the dark background.
      const text = await page.locator("#fp-add").evaluate((n) => getComputedStyle(n).color);
      expect(luminance(text)).toBeGreaterThan(0.2);
    });
  });

  test.describe("light", () => {
    test.use({ colorScheme: "light" });

    test("the page uses the light palette", async ({ page }) => {
      await gotoApp(page);
      expect(luminance(await background(page, "body"))).toBeGreaterThan(0.8);
    });
  });
});
