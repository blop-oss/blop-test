import { createBrowserTools } from "@blopai/browser-harness"
import { mkdtemp, readFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { chromium, type Browser } from "playwright"
import { expect, it } from "vitest"
import { startFixtureServer } from "../test-utils/server"

it.each([
	{ name: "viewport", viewport: { width: 320, height: 240 }, maxDimension: 2000, width: 320, height: 240, target: undefined },
	{ name: "scaled CDP", viewport: { width: 2400, height: 1200 }, maxDimension: 1200, width: 1200, height: 600, target: undefined },
	{ name: "scaled target", viewport: { width: 2400, height: 1200 }, maxDimension: 600, width: 600, height: 600, target: "#marker" },
])("captures painted first-frame pixels through the $name screenshot path", async ({ viewport, maxDimension, width, height, target }) => {
	const root = await mkdtemp(join(tmpdir(), "blop-first-frame-"))
	const server = await startFixtureServer([{
		path: "/",
		body: `<html><head><style>
			html, body { margin: 0; width: 100%; height: 100%; background: rgb(17, 102, 204); }
			#marker { width: 25%; height: 100%; background: black; }
		</style></head><body><div id="marker"></div><script>
			requestAnimationFrame(() => requestAnimationFrame(() => {
				document.getElementById("marker").style.background = "rgb(204, 51, 85)";
				document.getElementById("marker").style.width = "50%";
			}));
		</script></body></html>`,
	}])
	let browser: Browser | undefined
	try {
		browser = await chromium.launch({ headless: true })
		const page = await browser.newPage({ viewport })
		const tools = await createBrowserTools({
			page,
			testId: "first-frame",
			screenshotDir: root,
			actions: [],
			screenshots: [],
			finishState: { status: null, reason: null },
		})
		const screenshot = tools.find((tool) => tool.name === "browser_screenshot")!
		// Do not warm up the renderer with observations, sleeps, or a previous capture.
		await page.goto(server.url, { waitUntil: "domcontentloaded", timeout: 15_000 })
		const result = await screenshot.execute({ maxDimension, ...(target ? { target } : {}) })
		const png = await readFile(result.content)
		expect(png.subarray(0, 8)).toEqual(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
		expect([png.readUInt32BE(16), png.readUInt32BE(20)]).toEqual([width, height])
		const pixels = await page.evaluate(async (base64) => {
			const image = new Image()
			image.src = `data:image/png;base64,${base64}`
			await image.decode()
			const canvas = document.createElement("canvas")
			canvas.width = image.width
			canvas.height = image.height
			const context = canvas.getContext("2d")!
			context.drawImage(image, 0, 0)
			return [0.25, 0.75].map((x) => Array.from(context.getImageData(Math.floor(image.width * x), Math.floor(image.height / 2), 1, 1).data))
		}, png.toString("base64"))
		expect(pixels).toEqual(target
			? [[204, 51, 85, 255], [204, 51, 85, 255]]
			: [[204, 51, 85, 255], [17, 102, 204, 255]])
	} finally {
		await browser?.close()
		await server.close()
		await rm(root, { recursive: true, force: true })
	}
})
