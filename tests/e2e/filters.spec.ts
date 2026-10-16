import type { Locator, Page } from "@playwright/test";
import { columnTexts, expect, gotoApp, hashParams, openTable, test } from "./fixtures";

/** Fill condition `i` of the open filter panel. */
async function setCondition(page: Page, i: number, column: string, op: string, value: string): Promise<Locator> {
  const row = page.locator("#fp-rows .fp-row").nth(i);
  await row.getByLabel("Column", { exact: true }).selectOption(column);
  await row.getByLabel("Condition", { exact: true }).selectOption(op);
  await row.getByLabel("Value", { exact: true }).fill(value);
  return row;
}

/** orders, filtered to paid-or-refunded through the panel, applied. */
async function applyPaidOrRefunded(page: Page): Promise<void> {
  await openTable(page, "orders");
  await page.keyboard.press("f");
  await expect(page.locator("#filter-panel")).toBeVisible();
  await setCondition(page, 0, "status", "eq", "paid");
  await page.locator("#fp-add").click();
  await setCondition(page, 1, "status", "eq", "refunded");
  await page.locator("#fp-any").click();
  await expect(page.locator("#fp-any")).toHaveAttribute("aria-pressed", "true");
  await page.locator("#fp-apply").click();
  await expect(page.locator("#filter-btn .fp-count")).toHaveText("2");
}

async function expectOnlyPaidOrRefunded(page: Page): Promise<void> {
  await expect(page.locator("#grid tbody tr").first()).toBeVisible();
  const statuses = await columnTexts(page, "status");
  expect(statuses.length).toBeGreaterThan(0);
  expect(new Set(statuses)).toEqual(new Set(["paid", "refunded"]));
}

test.describe("filter panel", () => {
  test("f opens the panel and Esc closes it", async ({ page }) => {
    await gotoApp(page);
    await openTable(page, "orders");
    await expect(page.locator("#filter-panel")).toBeHidden();

    await page.keyboard.press("f");
    await expect(page.locator("#filter-panel")).toBeVisible();
    await expect(page.locator("#filter-btn")).toHaveAttribute("aria-expanded", "true");

    await page.keyboard.press("Escape");
    await expect(page.locator("#filter-panel")).toBeHidden();
    await expect(page.locator("#filter-btn")).toHaveAttribute("aria-expanded", "false");
  });

  test("two conditions combined with any: results, badge, URL and SQL preview", async ({ page }) => {
    await gotoApp(page);
    await applyPaidOrRefunded(page);

    await expectOnlyPaidOrRefunded(page);
    await expect(page.locator("#filter-btn")).toHaveText("Filter2");
    expect(hashParams(page).get("m")).toBe("any");
    expect(JSON.parse(hashParams(page).get("f")!)).toEqual([
      { c: "status", op: "eq", v: "paid" },
      { c: "status", op: "eq", v: "refunded" },
    ]);

    await page.locator("#fp-sql-btn").click();
    await expect(page.locator("#fp-sql-text")).toContainText("OR");
    await expect(page.locator("#fp-sql-text")).toContainText("'refunded'");

    await page.keyboard.press("Escape");
    await expect(page.locator("#filter-panel")).toBeHidden();
    // With the panel closed, the same conditions show as chips.
    await expect(page.locator("#chips .chip")).toHaveCount(2);
    await expect(page.locator("#chips .chips-mode")).toHaveText("any of");
  });

  test("a switched-off condition shows as a struck chip and changes nothing", async ({ page }) => {
    await gotoApp(page);
    await applyPaidOrRefunded(page);
    const before = await columnTexts(page, "id");

    await page.locator("#fp-add").click();
    const third = await setCondition(page, 2, "status", "eq", "shipped");
    await third.getByLabel("Condition on").uncheck();
    await expect(third).toHaveClass(/off/);
    await page.locator("#fp-apply").click();

    // Still two conditions on, and the same rows.
    await expect(page.locator("#filter-btn .fp-count")).toHaveText("2");
    expect(await columnTexts(page, "id")).toEqual(before);
    await expectOnlyPaidOrRefunded(page);

    await page.keyboard.press("Escape");
    const chips = page.locator("#chips .chip");
    await expect(chips).toHaveCount(3);
    await expect(chips.nth(2)).toHaveClass(/off/);
    await expect(chips.nth(2).locator(".chip-text")).toHaveCSS("text-decoration-line", "line-through");
    await expect(chips.nth(0)).not.toHaveClass(/off/);
    expect(JSON.parse(hashParams(page).get("f")!)[2]).toEqual({ c: "status", op: "eq", v: "shipped", off: true });
  });

  test("Back and Forward restore filters across tables; Clear removes them", async ({ page }) => {
    await gotoApp(page);
    await applyPaidOrRefunded(page);
    await page.keyboard.press("Escape");

    await openTable(page, "customers");
    await expect(page.locator("#filter-btn")).toHaveText("Filter");
    expect(hashParams(page).get("f")).toBeNull();

    await page.goBack();
    await expect(page.locator("#title")).toHaveText("orders");
    await expect(page.locator("#filter-btn .fp-count")).toHaveText("2");
    await expectOnlyPaidOrRefunded(page);
    expect(hashParams(page).get("m")).toBe("any");

    await page.goForward();
    await expect(page.locator("#title")).toHaveText("customers");
    await expect(page.locator("#filter-btn")).toHaveText("Filter");

    await page.goBack();
    await expect(page.locator("#filter-btn .fp-count")).toHaveText("2");

    // Clear: back to the plain table, no filters in the URL.
    await page.keyboard.press("f");
    await page.locator("#fp-clear").click();
    await expect(page.locator("#filter-btn")).toHaveText("Filter");
    await expect.poll(() => hashParams(page).get("f")).toBeNull();
    expect(hashParams(page).get("m")).toBeNull();
    const statuses = new Set(await columnTexts(page, "status"));
    expect(statuses.size).toBeGreaterThan(2);
  });
});
