import { expect, test } from "@playwright/test";

test("the dashboard shows the backend is up", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByText("Backend: up")).toBeVisible();
});
