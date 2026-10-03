import { defineConfig } from "vitest/config"

export default defineConfig({
	test: {
		include: ["test/vitest/**/*.test.ts"],
		environment: "node",
		pool: "forks",
		fileParallelism: false,
		testTimeout: 60_000,
		hookTimeout: 30_000,
	},
})
