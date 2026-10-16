import type { Page } from "@playwright/test";
import { expect, gotoApp, openTable, test } from "./fixtures";

/** Visible text outside data cells that looks like a bug: "null", "undefined", "NaN". */
async function strayText(page: Page): Promise<string[]> {
  return page.evaluate(() => {
    // Data from the database may legitimately say anything; the chrome may not.
    const skip = "#grid tbody, #insp-row, #insp-value, .d-code, #fp-sql-text";
    const bad = /null|undefined|NaN/; // case-sensitive: the UI's own "NULL" label is fine
    const found: string[] = [];
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    for (let n = walker.nextNode(); n; n = walker.nextNode()) {
      const parent = n.parentElement;
      if (!parent || parent.closest(skip) || parent.closest("script, style")) continue;
      if (!parent.checkVisibility()) continue;
      if (bad.test(n.textContent ?? "")) found.push(`${parent.tagName.toLowerCase()}#${parent.id}: ${n.textContent}`);
    }
    return found;
  });
}

test.describe("shell and styles", () => {
  test("home page loads with the default scope in the breadcrumb", async ({ page }) => {
    await gotoApp(page);
    await expect(page).toHaveTitle("PG Studio");
    await expect(page.locator("#conn-label")).toHaveText("Demo bookshop");
    await expect(page.locator("#db-label")).toHaveText("bookshop");
    await expect(page.locator("#schema-label")).toHaveText("public");
    await expect(page.locator(".scope")).toHaveText(/Demo bookshop\s*\/\s*bookshop\s*\/\s*public/);
    await expect(page.locator("#empty h1")).toHaveText("public");
    await expect(page.locator("#tables").getByRole("button", { name: /^orders/ })).toBeVisible();
  });

  test("shows the read-only badge", async ({ page }) => {
    await gotoApp(page);
    await expect(page.locator("#mode")).toHaveText("Read-only");
  });

  test("the whole stylesheet is applied, including rules at the very end", async ({ page }) => {
    await gotoApp(page);
    // A stray brace in styles.css silently drops everything after it, so probe
    // rules defined near the end of the file, not just the top.
    const styles = await page.evaluate(() => {
      const probe = (tag: string, cls: string, parentCls?: string) => {
        const node = document.createElement(tag);
        node.className = cls;
        let host: HTMLElement = document.body;
        if (parentCls) {
          host = document.createElement("div");
          host.className = parentCls;
          document.body.append(host);
        }
        host.append(node);
        const cs = getComputedStyle(node);
        const out = {
          display: cs.display,
          background: cs.backgroundColor,
          border: cs.borderTopWidth,
          weight: cs.fontWeight,
          minWidth: cs.minWidth,
          borderStyle: cs.borderTopStyle,
        };
        (parentCls ? host : node).remove();
        return out;
      };
      return {
        fpFoot: probe("div", "fp-foot"),
        fpAdd: probe("button", "fp-add"),
        rtBadge: probe("span", "rt-badge"),
        rtTag: probe("span", "rt-tag", "jump-list"),
        scopeMenu: probe("div", "scope-menu"),
        bodyBg: getComputedStyle(document.body).backgroundColor,
      };
    });
    expect(styles.fpFoot.display).toBe("flex");
    expect(styles.fpAdd.borderStyle).toBe("dashed");
    expect(styles.rtBadge.border).toBe("1px");
    expect(styles.rtBadge.weight).toBe("600");
    expect(styles.rtTag.background).not.toBe("rgba(0, 0, 0, 0)");
    expect(styles.scopeMenu.minWidth).toBe("260px");
    expect(styles.bodyBg).not.toBe("rgba(0, 0, 0, 0)");
  });

  test("the filter panel is styled when it opens", async ({ page }) => {
    await gotoApp(page);
    await openTable(page, "orders");
    await page.keyboard.press("f");
    const panel = page.locator("#filter-panel");
    await expect(panel).toBeVisible();
    await expect(panel.locator(".fp-foot")).toHaveCSS("display", "flex");
    await expect(panel.locator(".fp-row")).toHaveCSS("display", "grid");
    await expect(panel).toHaveCSS("border-top-width", "1px");
    // Controls laid out side by side, not stacked as unstyled blocks.
    const add = await panel.locator("#fp-add").boundingBox();
    const apply = await panel.locator("#fp-apply").boundingBox();
    expect(Math.abs(add!.y - apply!.y)).toBeLessThan(add!.height);
  });

  test("no stray null/undefined text in the chrome", async ({ page }) => {
    await gotoApp(page);
    expect(await strayText(page)).toEqual([]);

    await openTable(page, "orders");
    await expect(page.locator("#filter-btn")).toHaveText("Filter");
    await expect(page.locator("#filter-btn")).toHaveAccessibleName("Filter");
    expect(await strayText(page)).toEqual([]);

    await page.getByRole("tab", { name: "Structure" }).click();
    await expect(page.getByRole("heading", { name: /^Create script/ })).toBeVisible();
    expect(await strayText(page)).toEqual([]);
  });
});
