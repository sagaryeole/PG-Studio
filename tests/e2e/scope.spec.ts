import type { Page } from "@playwright/test";
import { DEMO, expect, gotoApp, hashParams, openTable, test } from "./fixtures";

async function switchDatabase(page: Page, name: string): Promise<void> {
  await page.locator("#db-btn").click();
  await page.locator("#db-menu").getByRole("menuitemradio", { name: new RegExp(`\\b${name}\\b`) }).click();
}

async function switchConnection(page: Page, name: string): Promise<void> {
  await page.locator("#conn-btn").click();
  await page.locator("#conn-menu").getByRole("menuitemradio", { name: new RegExp(name) }).click();
}

test.describe("connections and databases", () => {
  test("switching database shows that database's tables and updates the URL", async ({ page }) => {
    await gotoApp(page);
    await switchDatabase(page, "analytics");

    await expect(page.locator("#db-label")).toHaveText("analytics");
    await expect(page.locator("#tables button[title='page_views']")).toBeVisible();
    await expect(page.locator("#tables button[title='orders']")).toHaveCount(0);
    expect(hashParams(page).get("db")).toBe("analytics");
    await expect(page.locator("#conn-label")).toHaveText("Demo bookshop");

    // Back returns to the database we came from.
    await page.goBack();
    await expect(page.locator("#db-label")).toHaveText("bookshop");
    await expect(page.locator("#tables button[title='orders']")).toBeVisible();
    expect(hashParams(page).get("db")).toBeNull();

    await page.goForward();
    await expect(page.locator("#db-label")).toHaveText("analytics");
    await expect(page.locator("#tables button[title='page_views']")).toBeVisible();
  });

  test("switching connection uses that connection's own schema", async ({ page }) => {
    await gotoApp(page);
    await switchConnection(page, "Demo analytics");

    await expect(page.locator("#conn-label")).toHaveText("Demo analytics");
    await expect(page.locator("#db-label")).toHaveText("analytics");
    await expect(page.locator("#schema-label")).toHaveText("reporting");
    await expect(page.locator("#tables button[title='daily_views']")).toBeVisible();
    expect(hashParams(page).get("c")).toBe(DEMO.analyticsId);

    await page.goBack();
    await expect(page.locator("#conn-label")).toHaveText("Demo bookshop");
    await expect(page.locator("#schema-label")).toHaveText("public");
  });

  test("a database table opened after a switch keeps the scope in its URL", async ({ page }) => {
    await gotoApp(page);
    await switchDatabase(page, "analytics");
    await openTable(page, "page_views");
    expect(hashParams(page).get("db")).toBe("analytics");
    expect(hashParams(page).get("t")).toBe("page_views");

    await page.reload();
    await expect(page.locator("#title")).toHaveText("page_views");
    await expect(page.locator("#db-label")).toHaveText("analytics");
  });

  test("a link to a database that doesn't exist falls back to the default one", async ({ page, allowConsoleError }) => {
    allowConsoleError(/Failed to load resource/); // the API's 404 for the unknown database
    await gotoApp(page, "#db=nosuch");

    await expect(page.locator("#error")).toBeVisible();
    await expect(page.locator("#error-text")).toContainText("nosuch");
    await expect(page.locator("#db-label")).toHaveText("bookshop");
    await expect(page.locator("#tables button[title='orders']")).toBeVisible();
    expect(hashParams(page).get("db")).toBeNull();
  });

  test("rapid Back and Forward while a switch is loading does not break", async ({ page }) => {
    await gotoApp(page);
    await openTable(page, "orders");
    await switchDatabase(page, "analytics");
    await expect(page.locator("#tables button[title='page_views']")).toBeVisible();
    await switchConnection(page, "Demo analytics");
    await expect(page.locator("#schema-label")).toHaveText("reporting");

    // Hammer the history without waiting for any load to finish.
    for (let i = 0; i < 3; i++) {
      await page.goBack();
      await page.goBack();
      await page.goForward();
      await page.goForward();
    }

    // Wherever it lands, the page settles on a consistent, working state.
    await expect(page.locator("#grid-wrap")).not.toHaveClass(/loading/);
    await expect(page.locator("#tables h3").first()).toBeVisible();
    await expect(page.locator("#schema-label")).not.toHaveText("—");
    await expect(page.locator("#error")).toBeHidden();
    await expect(page.locator("#mode")).toHaveText("Read-only");
  });
});
