import { expect, gotoApp, hashParams, openTable, test } from "./fixtures";

test.describe("tables", () => {
  test("opens a table from the sidebar and shows rows", async ({ page }) => {
    await gotoApp(page);
    await openTable(page, "orders");
    await expect(page.locator("#grid tbody tr")).toHaveCount(50);
    await expect(page.locator("#grid thead .nm")).toContainText(["id", "customer_id", "status", "total_cents"]);
    await expect(page.locator("#row-info")).toContainText("Rows 1–50");
    await expect(page.locator("#facts")).toContainText("Primary key");
    expect(hashParams(page).get("t")).toBe("orders");
    await expect(page.locator("#tables button[title='orders']")).toHaveAttribute("aria-current", "true");
  });

  test("pages forward and back", async ({ page }) => {
    await gotoApp(page);
    await openTable(page, "orders");
    await expect(page.locator("#prev")).toBeDisabled();

    await page.locator("#next").click();
    await expect(page.locator("#page")).toHaveText("Page 2");
    await expect(page.locator("#row-info")).toContainText("Rows 51–100");
    await expect(page.locator("#grid tbody td.rownum").first()).toHaveText("51");

    await page.locator("#prev").click();
    await expect(page.locator("#page")).toHaveText("Page 1");
    await expect(page.locator("#grid tbody td.rownum").first()).toHaveText("1");
    await expect(page.locator("#prev")).toBeDisabled();
  });

  test("the jump dialog finds a table by typing and opens it on Enter", async ({ page }) => {
    await gotoApp(page);
    await page.keyboard.press("ControlOrMeta+K");
    const dialog = page.locator("#jump");
    await expect(dialog).toBeVisible();
    await expect(page.locator("#jump-input")).toBeFocused();

    await page.locator("#jump-input").fill("order_items");
    await expect(page.locator("#jump-list li[aria-selected='true']")).toContainText("order_items");
    await page.keyboard.press("Enter");

    await expect(dialog).toBeHidden();
    await expect(page.locator("#title")).toHaveText("order_items");
    await expect(page.locator("#grid tbody tr").first()).toBeVisible();
    expect(hashParams(page).get("t")).toBe("order_items");
  });

  test("the Structure tab renders its sections", async ({ page }) => {
    await gotoApp(page);
    await openTable(page, "orders");
    await page.getByRole("tab", { name: "Structure" }).click();

    await expect(page.locator("#details-pane")).toBeVisible();
    await expect(page.locator("#data-pane")).toBeHidden();
    for (const name of ["Overview", "Columns", "Indexes", "Constraints", "Relationships", "Create script"]) {
      await expect(page.getByRole("heading", { name: new RegExp(`^${name}`) })).toBeVisible();
    }
    await expect(page.locator(".d-table").first()).toBeVisible();
    await expect(page.locator(".d-code")).toContainText("CREATE TABLE");
    expect(hashParams(page).get("v")).toBe("details");

    await page.getByRole("tab", { name: "Data" }).click();
    await expect(page.locator("#grid tbody tr").first()).toBeVisible();
  });
});
