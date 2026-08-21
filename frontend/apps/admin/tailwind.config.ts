import type { Config } from 'tailwindcss'
import preset from '@lolipay/config/tailwind-preset'
const config: Config = {
  presets: [preset as unknown as Config],
  content: ['./app/**/*.{ts,tsx}', './components/**/*.{ts,tsx}', '../../packages/ui/src/**/*.{ts,tsx}'],
}
export default config
