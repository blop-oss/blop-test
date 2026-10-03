import { agentTest, describe } from "@blopai/test";

// Full product discovery → detail flow for elusive.dk.
//
// The previous run (elusive-products.blop.ts) only verified that the products
// page loaded. It never reached a product detail page because browser_click
// errored on malformed selectors when the agent tried to click product links
// or "Preview" elements. This spec covers the missing core flow:
//
//   homepage → products → search → product detail → image/description check
//
// It also requires explicit screenshots at key states and a mobile viewport
// pass, which the previous run lacked entirely.

describe("elusive.dk product detail", () => {
  agentTest("browses from homepage to a product detail page with screenshots and mobile viewport", async ({ agent }) => {
    await agent.goto("https://elusive.dk");
    await agent.goal(`
      You are testing the full product discovery-to-detail flow on a fashion
      marketplace. Work through every critical point below in order. Take
      explicit screenshots at each checkpoint — do not rely on implicit step
      captures alone. Finish as passed only if every critical point is proven
      by a deterministic assertion or visible evidence.

      ── CRITICAL POINTS ──

      1. Homepage loads and has a Products link
         - browser_goto https://elusive.dk
         - browser_snapshot to confirm the page rendered
         - browser_screenshot name="homepage" checkpoint="Homepage loaded"
         - Find and click the "Products" navigation link (try role: "link"
           with name "Products" first; if that fails, snapshot the nav and
           use the visible link text)
         - browser_expect_url to confirm you reached the products page
         - record_critical_point id="cp-homepage" status="passed"

      2. Products listing page renders with product cards
         - browser_snapshot to read the page structure
         - browser_screenshot name="products-listing" fullPage=true
           checkpoint="Products listing page"
         - browser_extract target={ role: "link" } fields=["text","attribute:href"]
           limit=20 to find product links and their hrefs
         - If extract returns product links, record at least one product name
           and its href as evidence
         - record_critical_point id="cp-products-listing" status="passed"

      3. Search functionality works
         - Find the search input on the products page (try role: "textbox"
           or label "Search" or placeholder "Search")
         - browser_type a fashion search term (e.g. "jacket" or "shirt")
           into the search box
         - browser_screenshot name="search-results" checkpoint="Search results populated"
         - browser_expect_count target={ role: "link" } count=1 comparison="at_least"
           to confirm at least one result is visible after searching
         - record_critical_point id="cp-search" status="passed"

      4. Product detail page opens and shows product content
         - From the search results (or the product listing if search returned
           nothing useful), click a product link to open its detail page.
           STRATEGY: Use browser_extract to get the first product link's href,
           then browser_goto that href directly — this is the most reliable
           way to reach a product detail page and avoids click-target issues.
           If the site uses a "Preview" button or card wrapper, snapshot first
           to understand the structure before clicking.
         - browser_expect_url to confirm you are on a product detail page
           (URL should contain /product or /products/ or a product slug)
         - browser_snapshot to read the product detail page
         - browser_screenshot name="product-detail" checkpoint="Product detail page"
         - browser_expect_text text that indicates product content is present
           (e.g. a price, a product description, an "Add to cart" button,
           or product image alt text)
         - record_critical_point id="cp-product-detail" status="passed"

      5. Product images are present and visible
         - Check for product images on the detail page
           (try target={ selector: "img" } with browser_expect_count
           count=1 comparison="at_least")
         - browser_screenshot name="product-images" checkpoint="Product images visible"
         - record_critical_point id="cp-product-images" status="passed"

      6. Product description or details are present
         - browser_expect_text to verify a product description, size guide,
           material info, or similar product detail content is visible
         - If no description text is found, snapshot the page and check for
           accordions or expandable sections that might contain details
         - record_critical_point id="cp-product-description" status="passed"

      7. Mobile viewport — product detail is usable on mobile
         - browser_set_viewport width=375 height=812 (iPhone X size)
         - browser_snapshot to check the page re-rendered for mobile
         - browser_screenshot name="product-detail-mobile"
           checkpoint="Product detail on mobile viewport" fullPage=true
         - Verify key elements are still visible on mobile:
           product image, product title/name, price, and a buy/add-to-cart
           action. Use browser_expect_visible for each.
         - browser_set_viewport width=1280 height=720 (reset to desktop)
         - record_critical_point id="cp-mobile" status="passed"

      ── BLOCKER HANDLING ──

      If a click or interaction fails after 3 different targeting strategies
      (role, text, selector), do NOT keep retrying with more selector variants.
      Instead:
      1. Call browser_snapshot to inspect the actual page structure.
      2. If the element is genuinely unreachable, record the critical point as
         failed with evidence from the snapshot.
      3. Try a fundamentally different approach (e.g. navigate directly to the
         product URL via browser_goto instead of clicking a link).
      4. If no alternative works, finish the test as failed with a clear reason
         explaining what was blocked and what evidence you gathered.

      ── SCREENSHOT CHECKLIST ──

      Take these explicit screenshots (do not skip any):
      - homepage: Homepage after initial load
      - products-listing: Full products listing page (fullPage=true)
      - search-results: Products page after a search query
      - product-detail: Product detail page on desktop
      - product-images: Product images on the detail page
      - product-detail-mobile: Product detail page on mobile viewport (fullPage=true)

      Finish by calling finish_test with status="passed" only if all 7
      critical points are proven. If any critical point failed, use
      status="failed" and explain which points failed and why in the reason.
    `);
  });
});
