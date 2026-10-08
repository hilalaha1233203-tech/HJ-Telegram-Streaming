import { cloudflareTest } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [
    cloudflareTest({
      wrangler: {
        configPath: "./wrangler.jsonc",
      },
      miniflare: {
        bindings: {
          TELEGRAM_BOT_TOKEN: "test-bot-token",
          SUPABASE_URL: "https://supabase.test",
          SUPABASE_PUBLISHABLE_KEY: "test-publishable",
          SUPABASE_SERVICE_ROLE_KEY: "test-service-role",
          MEDIA_INDEX_SUPABASE_URL: "https://supabase.test",
          MEDIA_INDEX_SUPABASE_SERVICE_ROLE_KEY: "test-media-index-service",
          EPISODE_CHUNKS_SUPABASE_URL: "https://supabase.test",
          EPISODE_CHUNKS_SUPABASE_SERVICE_ROLE_KEY: "test-chunks-service",
          HJ_WEB_BASE_URL: "https://web.test",
          MEDIA_TICKET_SECRET: "phase3-test-secret",
          CORS_ALLOWED_ORIGINS: "https://test.example",
          STORAGE_CHAT_ID: "12345"
        }
      }
    })
  ],
  test: {
    include: ["tests/**/*.test.js"],
    testTimeout: 30000
  }
});
