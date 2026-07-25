/**
 * Search the web.
 *
 * The agent's general-purpose search and research tool. It routes through Firecrawl's v2 Search
 * API, which fetches pages through infrastructure that bypasses the bot protection and blocks
 * that would stop a plain fetch/curl — so prefer it over fetching pages directly. Set
 * FIRECRAWL_API_KEY as a harnesst secret; the value is read from the tool process environment and
 * is never accepted as model input.
 */
import { defineTool } from "eve/tools";
import { z } from "zod";

const FIRECRAWL_SEARCH_URL = "https://api.firecrawl.dev/v2/search";

const sourceSchema = z.enum(["web", "images", "news"]);
const categorySchema = z.enum(["github", "research", "pdf"]);

const resultSchema = z.object({
  title: z.string().optional(),
  description: z.string().optional(),
  snippet: z.string().optional(),
  url: z.string().optional(),
  imageUrl: z.string().optional(),
  date: z.string().optional(),
  position: z.number().optional(),
  markdown: z.string().optional(),
  metadata: z
    .object({
      title: z.string().optional(),
      description: z.string().optional(),
      sourceURL: z.string().optional(),
      url: z.string().optional(),
      statusCode: z.number().optional(),
      error: z.string().optional(),
    })
    .passthrough()
    .optional(),
});

const responseSchema = z.object({
  success: z.boolean(),
  data: z
    .object({
      web: z.array(resultSchema).optional(),
      images: z.array(resultSchema).optional(),
      news: z.array(resultSchema).optional(),
    })
    .passthrough()
    .optional(),
  warning: z.string().nullable().optional(),
  id: z.string().optional(),
  creditsUsed: z.number().optional(),
  error: z.string().optional(),
});

function nonEmpty<T>(items: T[] | undefined): T[] | undefined {
  return items && items.length > 0 ? items : undefined;
}

function toTypedOptions<T extends string>(
  items: T[] | undefined,
): Array<{ type: T }> | undefined {
  return nonEmpty(items)?.map((type) => ({ type }));
}

function trimMarkdown(
  results: Array<z.infer<typeof resultSchema>>,
  maxChars: number,
) {
  return results.map((result) =>
    result.markdown && result.markdown.length > maxChars
      ? {
          ...result,
          markdown: `${result.markdown.slice(0, maxChars)}\n\n[truncated]`,
        }
      : result,
  );
}

export default defineTool({
  description:
    "Search and research the live web. Use this whenever you need to search or read web " +
    "pages — for current information, domain-limited research, news, images, or GitHub and " +
    "PDF discovery. It fetches through a service that bypasses the bot protection and blocks " +
    "that stop a plain fetch, so prefer it over fetching URLs yourself. Can also return " +
    "scraped markdown for each web/news result.",
  inputSchema: z
    .object({
      query: z
        .string()
        .min(1)
        .max(500)
        .describe(
          "Search query. Firecrawl supports operators like site:, filetype:, and intitle:.",
        ),
      limit: z
        .number()
        .int()
        .min(1)
        .max(25)
        .optional()
        .describe(
          "Maximum results per source. Defaults to 10; capped at 25 to keep output useful.",
        ),
      sources: z
        .array(sourceSchema)
        .min(1)
        .optional()
        .describe("Result sources to search. Defaults to ['web']."),
      categories: z
        .array(categorySchema)
        .optional()
        .describe(
          "Optional filters for web results: github, research, or pdf.",
        ),
      includeDomains: z
        .array(z.string().min(1))
        .optional()
        .describe(
          "Only return results from these hostnames, without protocol or path.",
        ),
      excludeDomains: z
        .array(z.string().min(1))
        .optional()
        .describe(
          "Exclude results from these hostnames, without protocol or path.",
        ),
      tbs: z
        .string()
        .optional()
        .describe(
          "Time filter, e.g. qdr:d, qdr:w, qdr:m, qdr:y, or sbd:1,qdr:w.",
        ),
      country: z
        .string()
        .length(2)
        .optional()
        .describe(
          "ISO country code for geo-targeted results, e.g. US, DE, JP.",
        ),
      location: z
        .string()
        .optional()
        .describe(
          "Geo-targeted location, e.g. San Francisco,California,United States.",
        ),
      includeMarkdown: z
        .boolean()
        .optional()
        .describe(
          "When true, ask Firecrawl to scrape markdown content for each result.",
        ),
      maxMarkdownChars: z
        .number()
        .int()
        .min(500)
        .max(20000)
        .optional()
        .describe(
          "Maximum markdown characters per result returned to the model. Defaults to 4000.",
        ),
      timeoutMs: z
        .number()
        .int()
        .min(1000)
        .max(60000)
        .optional()
        .describe(
          "Firecrawl request timeout in milliseconds. Defaults to 30000.",
        ),
    })
    .refine(
      (input) =>
        !(input.includeDomains?.length && input.excludeDomains?.length),
      "includeDomains and excludeDomains cannot both be set.",
    ),
  async execute(input) {
    const apiKey = process.env.FIRECRAWL_API_KEY;
    if (!apiKey) {
      return {
        ok: false,
        error:
          "Missing FIRECRAWL_API_KEY. Set it as a harnesst secret before searching.",
      };
    }

    const maxMarkdownChars = input.maxMarkdownChars ?? 4000;
    const body = {
      query: input.query,
      limit: input.limit ?? 10,
      sources: toTypedOptions(input.sources),
      categories: toTypedOptions(input.categories),
      includeDomains: nonEmpty(input.includeDomains),
      excludeDomains: nonEmpty(input.excludeDomains),
      tbs: input.tbs,
      country: input.country,
      location: input.location,
      timeout: input.timeoutMs ?? 30000,
      scrapeOptions: input.includeMarkdown
        ? { formats: [{ type: "markdown" }] }
        : undefined,
    };

    const response = await fetch(FIRECRAWL_SEARCH_URL, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    });

    const raw = await response.text();
    let json: unknown;
    try {
      json = raw ? JSON.parse(raw) : {};
    } catch {
      return {
        ok: false,
        status: response.status,
        error: raw || "Firecrawl returned a non-JSON response.",
      };
    }

    const parsed = responseSchema.safeParse(json);
    if (!response.ok || !parsed.success || !parsed.data.success) {
      return {
        ok: false,
        status: response.status,
        error:
          parsed.success && parsed.data.error
            ? parsed.data.error
            : `Firecrawl search failed with HTTP ${response.status}.`,
        response: json,
      };
    }

    const data = parsed.data.data ?? {};
    return {
      ok: true,
      id: parsed.data.id,
      warning: parsed.data.warning,
      creditsUsed: parsed.data.creditsUsed,
      results: {
        web: data.web ? trimMarkdown(data.web, maxMarkdownChars) : undefined,
        images: data.images,
        news: data.news ? trimMarkdown(data.news, maxMarkdownChars) : undefined,
      },
    };
  },
});
