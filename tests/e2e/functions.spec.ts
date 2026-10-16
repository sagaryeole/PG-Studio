import { DEMO, expect, gotoApp, hashParams, test } from "./fixtures";

test.describe("functions and procedures", () => {
  test("the sidebar lists Functions and Procedures", async ({ page }) => {
    await gotoApp(page);
    const nav = page.locator("#tables");
    await expect(nav.getByRole("heading", { name: /^Functions \(\d+\)/ })).toBeVisible();
    await expect(nav.getByRole("heading", { name: /^Procedures \(1\)/ })).toBeVisible();
    await expect(nav.locator("button[title^='refresh_book_sales(']")).toBeVisible();
    // Overloads are told apart by argument count.
    await expect(nav.locator("button[title^='format_price(']")).toHaveCount(2);
    await expect(nav.locator("button[title^='format_price('] .tcount").first()).toContainText("arg");
  });

  test("a function page shows its definition", async ({ page }) => {
    await gotoApp(page);
    await page.locator("#tables button[title^='top_books_by_revenue(']").click();

    await expect(page.locator("#routine")).toBeVisible();
    await expect(page.locator("#routine-title")).toContainText("top_books_by_revenue(");
    await expect(page.locator("#routine-body .d-code")).toContainText("CREATE OR REPLACE FUNCTION");
    await expect(page.locator("#routine-facts")).toContainText("plpgsql");
    expect(hashParams(page).get("fn")).toMatch(/^\d+$/);
  });

  test("SECURITY DEFINER functions carry a badge", async ({ page }) => {
    await gotoApp(page);
    await page.locator("#tables button[title^='customer_order_count(']").click();
    await expect(page.locator("#routine-title")).toContainText("customer_order_count(");
    const badge = page.locator("#routine-facts .rt-badge");
    await expect(badge).toHaveText("SECURITY DEFINER");
    await expect(badge).toHaveCSS("border-top-width", "1px");

    // A plain function does not.
    await page.locator("#tables button[title^='book_rating(']").click();
    await expect(page.locator("#routine-title")).toContainText("book_rating(");
    await expect(page.locator("#routine-facts .rt-badge")).toHaveCount(0);
  });

  test("#fn=<oid> deep links survive a reload", async ({ page, request }) => {
    const res = await request.get(`/api/routines?conn=${DEMO.bookshopId}`);
    expect(res.ok()).toBe(true);
    const { routines } = (await res.json()) as { routines: { oid: string; name: string }[] };
    const fn = routines.find((r) => r.name === "top_books_by_revenue");
    expect(fn).toBeDefined();

    await gotoApp(page, `#fn=${fn!.oid}`);
    await expect(page.locator("#routine-title")).toContainText("top_books_by_revenue(");
    await page.reload();
    await expect(page.locator("#routine-title")).toContainText("top_books_by_revenue(");
    await expect(page.locator("#routine-body .d-code")).toContainText("CREATE OR REPLACE FUNCTION");
    await expect(page.locator("#tables button[title^='top_books_by_revenue(']")).toHaveAttribute("aria-current", "true");
  });

  test("the jump dialog finds functions too", async ({ page }) => {
    await gotoApp(page);
    await page.keyboard.press("ControlOrMeta+K");
    await page.locator("#jump-input").fill("refresh_book");
    await expect(page.locator("#jump-list li[aria-selected='true'] .rt-tag")).toHaveText("proc");
    await expect(page.locator("#jump-list li[aria-selected='true'] .rt-tag")).toHaveCSS("border-top-left-radius", "4px");
    await page.keyboard.press("Enter");
    await expect(page.locator("#routine-title")).toContainText("refresh_book_sales(");
  });
});
