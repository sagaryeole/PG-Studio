import { expect, gotoApp, hashParams, openTable, test } from "./fixtures";

test.describe("inspector", () => {
  test("clicking a cell opens the side panel with the whole row", async ({ page }) => {
    await gotoApp(page);
    await openTable(page, "orders");
    await expect(page.locator("#inspector")).toBeHidden();

    await page.locator("#grid tbody td.cell[data-r='0']").nth(2).click(); // third column: status
    const panel = page.locator("#inspector");
    await expect(panel).toBeVisible();
    await expect(page.locator("#insp-col")).toHaveText("status");
    await expect(page.locator("#insp-value")).not.toBeEmpty();
    await expect(page.locator("#insp-row button")).toHaveCount(await page.locator("#grid thead .nm").count());
    await expect(page.locator("#grid td.selected")).toHaveCount(1);

    await page.keyboard.press("Escape");
    await expect(panel).toBeHidden();
  });

  test("a foreign-key arrow opens the referenced row, and Back returns", async ({ page }) => {
    await gotoApp(page);
    await openTable(page, "orders");

    const cell = page.locator("#grid tbody td.has-fk").first();
    const customerId = await cell.getAttribute("title");
    expect(customerId).toMatch(/^\d+$/);
    await cell.locator(".fk-go").click();

    await expect(page.locator("#title")).toHaveText("customers");
    await expect(page.locator("#filter-btn .fp-count")).toHaveText("1");
    await expect(page.locator("#chips .chip-text")).toContainText(`id = ${customerId}`);
    await expect(page.locator("#grid tbody tr")).toHaveCount(1);
    expect(JSON.parse(hashParams(page).get("f")!)).toEqual([{ c: "id", op: "eq", v: customerId }]);

    await page.goBack();
    await expect(page.locator("#title")).toHaveText("orders");
    await expect(page.locator("#filter-btn")).toHaveText("Filter");
    await expect(page.locator("#grid tbody tr")).toHaveCount(50);
  });
});
