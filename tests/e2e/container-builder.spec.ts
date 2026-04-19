import { test, expect } from '@playwright/test'

import { gotoKanban } from './ui-helpers'

test.describe('Container Image Builder', () => {
  test.beforeEach(async ({ page }) => {
    await gotoKanban(page)
    await page.getByRole('tab', { name: 'Containers' }).click()
    await expect(page.getByRole('heading', { name: 'Container Image Builder' })).toBeVisible({ timeout: 10000 })
  })

  test('shows the available base profiles and build history', async ({ page }) => {
    const profileSelect = page.locator('select.form-select').first()
    const availableProfiles = profileSelect.locator('option').filter({ hasText: / - / })
    const buildHistoryLabel = page.locator('label').filter({ hasText: 'Build History' }).first()

    await expect(profileSelect).toBeVisible()
    await expect.poll(async () => availableProfiles.count(), { timeout: 10000 }).toBeGreaterThan(0)
    await expect(buildHistoryLabel).toBeVisible()
  })

  test('loading a profile populates the Dockerfile and enables Save & Build', async ({ page }) => {
    const profileSelect = page.locator('select.form-select').first()
    const dockerfileTextarea = page.locator('textarea.form-textarea').first()
    const buildButton = page.getByRole('button', { name: 'Save & Build' })

    await expect(buildButton).toBeDisabled()

    const firstProfileValue = await profileSelect.locator('option').nth(1).getAttribute('value')
    expect(firstProfileValue).toBeTruthy()

    await profileSelect.selectOption(firstProfileValue!)
    await expect(dockerfileTextarea).toHaveValue(/FROM/, { timeout: 10000 })
    await expect(buildButton).toBeEnabled()
  })

  test('editing the Dockerfile exposes Save as New Profile and Reset', async ({ page }) => {
    const profileSelect = page.locator('select.form-select').first()
    const dockerfileTextarea = page.locator('textarea.form-textarea').first()

    const firstProfileValue = await profileSelect.locator('option').nth(1).getAttribute('value')
    expect(firstProfileValue).toBeTruthy()

    await profileSelect.selectOption(firstProfileValue!)
    await expect(dockerfileTextarea).toHaveValue(/FROM/, { timeout: 10000 })
    const originalDockerfile = await dockerfileTextarea.inputValue()

    await dockerfileTextarea.fill(`${originalDockerfile}\nRUN echo helper-test`)
    await dockerfileTextarea.press('Tab')
    await expect(page.getByRole('button', { name: 'Save as New Profile' })).toBeVisible()
    await expect(page.getByRole('button', { name: 'Reset' })).toBeVisible()

    await page.getByRole('button', { name: 'Reset' }).click()
    await expect(dockerfileTextarea).toHaveValue(originalDockerfile)
    await expect(page.getByRole('button', { name: 'Save as New Profile' })).not.toBeVisible()
  })
})