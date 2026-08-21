import { test, expect } from '@playwright/test'
import { setupApiMocks, MOCK_ORDER_FUNDED, MOCK_ORDER_MATCHED } from './mocks'

test.describe('Home page', () => {
  test('shows the live USDC/IDR rate', async ({ page }) => {
    await setupApiMocks(page)
    await page.goto('/')

    await expect(page.getByText(/Rp 16\.000/)).toBeVisible({ timeout: 10_000 })
  })

  test('bottom nav is present on the home page', async ({ page }) => {
    await setupApiMocks(page)
    await page.goto('/')

    await expect(page.getByRole('navigation')).toBeVisible()
    await expect(page.getByRole('navigation').getByText('Home')).toBeVisible()
  })
})

test.describe('/buy page', () => {
  test('shows net USDC after entering an IDR amount', async ({ page }) => {
    await setupApiMocks(page)
    await page.goto('/buy')

    const input = page.getByRole('textbox')
    await input.fill('1600000')

    await expect(page.getByText(/98\.50\s*USDC/)).toBeVisible({ timeout: 5_000 })
  })

  test('"You get" line starts at 0.00 USDC before input', async ({ page }) => {
    await setupApiMocks(page)
    await page.goto('/buy')

    await expect(page.getByText(/0\.00\s*USDC/)).toBeVisible({ timeout: 5_000 })
  })

  test('Continue to pay opens the review sheet with the locked quote, then confirms the order', async ({
    page,
  }) => {
    await setupApiMocks(page)
    await page.goto('/buy')

    const input = page.getByRole('textbox')
    await input.fill('1600000')
    await expect(page.getByText(/98\.50\s*USDC/)).toBeVisible({ timeout: 5_000 })

    await page.getByRole('button', { name: 'Continue to pay' }).click()
    await expect(page.getByText('Review order')).toBeVisible()
    await expect(
      page.getByText(
        "Funds are held in on-chain escrow and released only when both sides confirm. If anything goes wrong, you're refunded.",
      ),
    ).toBeVisible()

    await page.getByRole('button', { name: /Confirm — sign/i }).click()
    await expect(page).toHaveURL(/\/orders\/o1/)
  })
})

test.describe('/orders/o1 at MATCHED status', () => {
  test('payment instructions card is NOT shown', async ({ page }) => {
    await setupApiMocks(page, MOCK_ORDER_MATCHED)
    await page.goto('/orders/o1')

    await expect(page.getByText('MATCHED')).toBeVisible({ timeout: 10_000 })

    await expect(page.getByText('Transfer to')).not.toBeVisible()

    await expect(page.getByTestId('ive-paid-slot')).not.toBeVisible()
  })
})

test.describe('/orders/o1 at FUNDED status', () => {
  test('payment instructions are shown', async ({ page }) => {
    await setupApiMocks(page, MOCK_ORDER_FUNDED)
    await page.goto('/orders/o1')

    await expect(page.getByText('FUNDED')).toBeVisible({ timeout: 10_000 })

    await expect(page.getByText('Transfer to')).toBeVisible()
    await expect(page.getByText('BCA 1234567890 a/n TEST MERCHANT')).toBeVisible()
  })

  test('"I\'ve paid" button is present in the sticky slot', async ({ page }) => {
    await setupApiMocks(page, MOCK_ORDER_FUNDED)
    await page.goto('/orders/o1')

    await expect(page.getByText('FUNDED')).toBeVisible({ timeout: 10_000 })

    const slot = page.getByTestId('ive-paid-slot')
    await expect(slot).toBeVisible()
    await expect(slot.getByRole('button', { name: /I've paid/i })).toBeVisible()
  })

  test('confirm button in IvePaidSheet is disabled until checkbox is ticked', async ({ page }) => {
    await setupApiMocks(page, MOCK_ORDER_FUNDED)
    await page.goto('/orders/o1')

    await expect(page.getByText('FUNDED')).toBeVisible({ timeout: 10_000 })

    const slot = page.getByTestId('ive-paid-slot')
    await slot
      .getByRole('button', { name: /I've paid/i })
      .evaluate((el) => (el as HTMLButtonElement).click())

    await expect(page.getByText('Did you already pay?')).toBeVisible({ timeout: 3_000 })

    const confirmBtn = page.getByRole('button', { name: /Yes, I've paid/i })
    await expect(confirmBtn).toBeDisabled()

    await page.getByRole('checkbox').check()

    await expect(confirmBtn).toBeEnabled()
  })
})
