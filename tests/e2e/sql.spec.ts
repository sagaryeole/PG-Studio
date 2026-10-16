import { expect, gotoApp, hashParams, openTable, test } from "./fixtures";
import type { Page } from "@playwright/test";

const editor = (page: Page) => page.locator("#sql-input");
const status = (page: Page) => page.locator("#sql-status");
const MOD = process.platform === "darwin" ? "Meta" : "Control";

async function openEditor(page: Page): Promise<void> {
  await gotoApp(page);
  await page.keyboard.press("q");
  await expect(page.locator("#query")).toBeVisible();
  await expect(editor(page)).toBeFocused();
}

async function run(page: Page, sql: string): Promise<void> {
  await editor(page).fill(sql);
  await editor(page).press(`${MOD}+Enter`);
  await expect(page.locator("#sql-results")).not.toHaveClass(/loading/);
}

test.describe("SQL editor", () => {
  test("Q opens the editor and the run shortcut shows typed results", async ({ page }) => {
    await openEditor(page);
    await expect(page.locator("#query-facts")).toContainText("Read-only transaction");
    await run(page, "select id, name from authors order by id limit 3;");

    await expect(page.locator("#sql-grid tbody tr")).toHaveCount(3);
    await expect(page.locator("#sql-grid thead th .nm")).toHaveText(["id", "name"]);
    await expect(page.locator("#sql-grid thead th .ctype").first()).toHaveText("integer");
    await expect(page.locator("#sql-grid tbody tr").first().locator("td.num")).toHaveText("1");
    await expect(status(page)).toContainText(/^3 rows · \d/);
    // The query is in the link (it never runs from one; see below).
    expect(hashParams(page).get("sql")).toBe("select id, name from authors order by id limit 3;");
  });

  test("only the selected part runs when there is a selection", async ({ page }) => {
    await openEditor(page);
    await editor(page).fill("select 1 as first_one;\nselect 2 as second_one");
    await editor(page).evaluate((ta: HTMLTextAreaElement) => ta.setSelectionRange(ta.value.indexOf("select 2"), ta.value.length));
    await page.locator("#sql-run").click();
    await expect(page.locator("#sql-grid thead th .nm")).toHaveText(["second_one"]);
  });

  test("an error says where it is and underlines it", async ({ page, allowConsoleError }) => {
    allowConsoleError(/400 \(Bad Request\)/);
    await openEditor(page);
    await run(page, "select id,\n  no_such_column\nfrom authors");
    const box = page.locator("#sql-error");
    await expect(box).toContainText('column "no_such_column" does not exist');
    await expect(box.getByRole("button", { name: "Line 2, column 3" })).toBeVisible();
    await expect(page.locator("#sql-highlight .tk-err")).toHaveText("no_such_column");

    // Typing clears the marker; a good query clears the error.
    await editor(page).press("End");
    await editor(page).type(" ");
    await expect(page.locator("#sql-highlight .tk-err")).toHaveCount(0);
    await run(page, "select 1");
    await expect(box).toBeHidden();
  });

  test("writes, session changes and multiple statements are refused", async ({ page, allowConsoleError }) => {
    allowConsoleError(/400 \(Bad Request\)/);
    await openEditor(page);
    const box = page.locator("#sql-error");

    await run(page, "delete from orders");
    await expect(box).toContainText("only runs read queries");
    await run(page, "set statement_timeout = 0");
    await expect(box).toContainText("only runs read queries");
    await run(page, "select 1; delete from orders");
    await expect(box).toContainText("one statement");
    await run(page, "with gone as (delete from orders returning id) select count(*) from gone");
    await expect(box).toContainText("top level");
    await run(page, "select * from orders limit 1 for update");
    await expect(box).toContainText("read-only transaction");

    // Nothing was touched.
    await run(page, "select count(*) > 100000 as still_there from orders");
    await expect(page.locator("#sql-grid tbody td.cell")).toHaveText("t");
  });

  test("Explain analyze shows the plan with timings", async ({ page }) => {
    await openEditor(page);
    await editor(page).fill("select count(*) from orders where status = 'paid'");
    await page.locator("#sql-analyze").click();
    await expect(page.locator("#sql-plan")).toBeVisible();
    await expect(page.locator("#sql-plan")).toContainText("actual time=");
    await expect(page.locator("#sql-results")).toBeHidden();
    await expect(page.locator("#sql-export-btn")).toBeDisabled();
    await expect(status(page)).toContainText("Ran the query");
  });

  test("Cancel stops a long query", async ({ page }) => {
    await openEditor(page);
    await editor(page).fill("select pg_sleep(20)");
    await page.locator("#sql-run").click();
    await expect(status(page)).toContainText("Running…");
    await page.locator("#sql-cancel").click();
    await expect(status(page)).toContainText("Cancelled");
    await expect(page.locator("#sql-cancel")).toBeHidden();
    await expect(page.locator("#sql-run")).toBeEnabled();
  });

  test("a link fills the editor but never runs it", async ({ page }) => {
    await gotoApp(page, "#sql=select+42+as+answer");
    await expect(page.locator("#query")).toBeVisible();
    await expect(editor(page)).toHaveValue("select 42 as answer");
    await expect(status(page)).toContainText("Loaded from the link");
    await expect(page.locator("#sql-grid tbody tr")).toHaveCount(0);
    await editor(page).press(`${MOD}+Enter`);
    await expect(page.locator("#sql-grid tbody td.cell")).toHaveText("42");
  });

  test("history and the draft survive a reload", async ({ page }) => {
    await openEditor(page);
    await run(page, "select 'from history' as h");
    await editor(page).fill("select 'unsaved draft'");
    await page.waitForTimeout(400); // the draft is saved shortly after typing stops
    await page.goto("/#sql");
    await expect(editor(page)).toHaveValue("select 'unsaved draft'");

    await page.locator("#sql-history-btn").click();
    const item = page.locator(".hist-item", { hasText: "from history" });
    await expect(item).toBeVisible();
    await item.click();
    await expect(editor(page)).toHaveValue("select 'from history' as h");
  });

  test("result cells open in the inspector", async ({ page }) => {
    await openEditor(page);
    await run(page, "select id, metadata from books order by id limit 2");
    await page.locator("#sql-grid tbody tr").first().locator("td.cell").nth(1).click();
    await expect(page.locator("#inspector")).toBeVisible();
    await expect(page.locator("#insp-col")).toHaveText("metadata");
    await expect(page.locator("#insp-type")).toHaveText("jsonb");
    await expect(page.locator("#insp-value")).toContainText('"pages":');
    await expect(page.locator("#insp-filter")).toBeHidden();
    await page.keyboard.press("Escape");
    await expect(page.locator("#inspector")).toBeHidden();
  });

  test("the filter panel's SQL opens in the editor", async ({ page }) => {
    await gotoApp(page);
    await openTable(page, "orders");
    await page.keyboard.press("f");
    await page.locator("#fp-sql-btn").click();
    await expect(page.locator("#fp-sql-text")).toContainText("FROM");
    await page.locator("#fp-open-sql").click();
    await expect(page.locator("#query")).toBeVisible();
    await expect(editor(page)).toHaveValue(/FROM "public"\."orders"/);
    await editor(page).press(`${MOD}+Enter`);
    await expect(page.locator("#sql-grid tbody tr")).toHaveCount(50);
  });

  test("switching database keeps the editor and its text", async ({ page }) => {
    await openEditor(page);
    await run(page, "select current_database()");
    await expect(page.locator("#sql-grid tbody td.cell")).toHaveText("bookshop");

    await page.locator("#db-btn").click();
    await page.locator("#db-menu").getByRole("menuitemradio", { name: /analytics/ }).click();
    await expect(page.locator("#db-label")).toHaveText("analytics");
    await expect(page.locator("#query")).toBeVisible();
    await expect(editor(page)).toHaveValue("select current_database()");
    await editor(page).press(`${MOD}+Enter`);
    await expect(page.locator("#sql-grid tbody td.cell")).toHaveText("analytics");
  });
});
