import vinext from 'vinext';
import { defineConfig } from 'vite';

export default defineConfig({
  server: { watch: { ignored: ['**/tmp/**', '**/dist/**'] } },
  plugins: [vinext()],
});
